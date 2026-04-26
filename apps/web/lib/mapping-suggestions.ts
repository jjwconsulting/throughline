// Suggestion engine for distributor → Veeva account mapping.
//
// Strategy: hard-filter candidates to the same state (50x prune), score
// remaining candidates by name similarity (Jaro-Winkler) with bonuses for
// matching city / postal code. Return top N over a confidence threshold.
//
// HCO-only by design: 867 sales data ships to physical sites (hospitals,
// clinics, pharmacies, infusion centers) — all HCO. HCP-level prescribing
// lives in a different feed (Xponent / IQVIA). Suggesting HCPs from a
// distributor name like "Smith Medical Center" creates false-positive
// risk (e.g., matching "Dr. John Smith"). Admins can still pick an HCP
// manually via the per-row search picker for the rare specialty pharma
// direct-to-physician case.
//
// Why "Suggested" not "Recommended" — tone matches the goals product:
// suggestions are a starting point with no commitment, the admin still
// owns the final pick. Lighter framing reduces overhang from
// false-positive matches.

import { queryFabric } from "@/lib/fabric";
import { jaroWinkler, normalizeName } from "@/lib/string-similarity";

export type SuggestionCandidate = {
  veeva_account_id: string;
  account_type: "HCP" | "HCO";
  name: string;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  detail: string | null; // npi for HCP, hco_type for HCO
  score: number; // [0, 1] composite confidence
};

export type UnmappedAccountForSuggest = {
  distributor_account_id: string;
  distributor_account_name: string | null;
  account_state: string | null;
  account_city?: string | null;
  account_postal_code?: string | null;
};

const NAME_WEIGHT = 0.75;
const CITY_BONUS = 0.15;
const POSTAL_BONUS = 0.1;
const MIN_SCORE = 0.6;
const TOP_N = 3;

// Pulls all candidate Veeva accounts (HCP + HCO) for the states represented
// in the unmapped list, then scores in-memory. One round-trip + O(n*m)
// scoring where m is bounded by the candidate pool of those states.
export async function suggestForUnmapped(
  tenantId: string,
  unmapped: UnmappedAccountForSuggest[],
): Promise<Map<string, SuggestionCandidate[]>> {
  const out = new Map<string, SuggestionCandidate[]>();
  if (unmapped.length === 0) return out;

  // Need richer address columns than loadUnmappedAccounts currently
  // returns. Pull them in one pass alongside the state list.
  const states = new Set<string>();
  for (const u of unmapped) {
    if (u.account_state) states.add(u.account_state.trim().toUpperCase());
  }
  // No state info on any unmapped row → fall back to a national search,
  // capped to keep the candidate pool manageable. Edge case (data without
  // state); the typical IC 867 file has state on every row.
  const stateFilter =
    states.size > 0
      ? `AND UPPER(state) IN (${Array.from(states)
          .map((s) => `'${s.replace(/'/g, "''")}'`)
          .join(",")})`
      : "";

  let candidates: Omit<SuggestionCandidate, "score">[] = [];
  try {
    const hcoRows = await queryFabric<
      Omit<SuggestionCandidate, "score" | "account_type" | "detail"> & {
        hco_type: string | null;
      }
    >(
      tenantId,
      `SELECT TOP 10000
         veeva_account_id, name, city, state, postal_code, hco_type
       FROM gold.dim_hco
       WHERE tenant_id = @tenantId AND name IS NOT NULL ${stateFilter}`,
    );
    candidates = hcoRows.map((r) => ({
      veeva_account_id: r.veeva_account_id,
      account_type: "HCO" as const,
      name: r.name,
      city: r.city,
      state: r.state,
      postal_code: r.postal_code,
      detail: r.hco_type,
    }));
  } catch {
    return out;
  }
  if (candidates.length === 0) return out;

  // Index candidates by normalized state so scoring loops only consider
  // the local pool — much cheaper than scoring all 30k each time.
  const candidatesByState = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const key = (c.state ?? "").trim().toUpperCase();
    const bucket = candidatesByState.get(key);
    if (bucket) bucket.push(c);
    else candidatesByState.set(key, [c]);
  }

  for (const u of unmapped) {
    if (!u.distributor_account_name) continue;
    const distName = normalizeName(u.distributor_account_name);
    if (!distName) continue;
    const distState = (u.account_state ?? "").trim().toUpperCase();
    const distCity = (u.account_city ?? "").trim().toLowerCase();
    const distPostal = (u.account_postal_code ?? "").trim();

    const pool =
      candidatesByState.get(distState) ??
      // Distributor row has no state — score against everything (rare).
      candidates;

    const scored: SuggestionCandidate[] = [];
    for (const c of pool) {
      const cName = normalizeName(c.name);
      if (!cName) continue;
      const nameSim = jaroWinkler(distName, cName);
      const cityMatch =
        distCity && c.city && c.city.trim().toLowerCase() === distCity ? 1 : 0;
      const postalMatch =
        distPostal && c.postal_code && c.postal_code.trim() === distPostal ? 1 : 0;
      const score =
        nameSim * NAME_WEIGHT + cityMatch * CITY_BONUS + postalMatch * POSTAL_BONUS;
      if (score >= MIN_SCORE) {
        scored.push({ ...c, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    if (scored.length > 0) {
      out.set(u.distributor_account_id, scored.slice(0, TOP_N));
    }
  }

  return out;
}
