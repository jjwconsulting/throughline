// HCP target scores — Phase 2 of tenant-custom attributes architecture.
// Reads `gold.hcp_target_score` (composite 0-100 "should-call" score per
// HCP × scope_tag, built from third-party scoring attributes like Komodo
// volumes / Clarivate procedure counts via /admin/attributes config).
//
// Two loaders:
//   - loadHcpTargetScoresByKeys: enriches a known set of HCPs with
//     their composite scores. For tier-style "here's how this HCP
//     ranks" context on entities already in the LLM input bag.
//   - loadTopScoringUncalledHcpsForRep: the actionable surface —
//     finds HCPs in a rep's coverage (via territory bridge), filters
//     out recently-called ones, ranks by composite score, returns top N
//     with their parent HCO + last-call gap. This is what
//     rep-recommendations consumes to recommend "you have explicit
//     coverage of these high-scoring HCPs but haven't engaged."
//
// Cross-references:
//   - docs/architecture/tenant-custom-attributes.md
//   - project_llm_input_extensibility memory (input plug-in pattern)

import { queryFabric } from "@/lib/fabric";

export type HcpTargetScoreContributor = {
  attribute_name: string;
  raw_value: string;
  normalized: number;
  source_label: string;
  scope_tag: string | null;
};

export type HcpTargetScoreRow = {
  hcp_key: string;
  scope_tag: string;
  score_value: number;
  contributor_count: number;
  contributors: HcpTargetScoreContributor[];
};

const ALL_SCOPE = "__all__";

function parseContributors(raw: string | null): HcpTargetScoreContributor[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive shape check — gold writer emits the right shape but the
    // JSON column is just a string, so we tolerate drift here.
    return parsed.filter(
      (c): c is HcpTargetScoreContributor =>
        c &&
        typeof c.attribute_name === "string" &&
        typeof c.normalized === "number",
    );
  } catch {
    return [];
  }
}

// Enrich a known set of HCPs with their composite score for the given
// scope_tag (default '__all__' = cross-therapy-area composite).
export async function loadHcpTargetScoresByKeys(args: {
  tenantId: string;
  hcpKeys: string[];
  scopeTag?: string;
}): Promise<HcpTargetScoreRow[]> {
  const { tenantId, hcpKeys, scopeTag = ALL_SCOPE } = args;
  if (hcpKeys.length === 0) return [];

  const escIn = hcpKeys.map((k) => `'${k.replace(/'/g, "''")}'`).join(",");
  try {
    const rows = await queryFabric<{
      hcp_key: string;
      scope_tag: string;
      score_value: number;
      contributor_count: number;
      contributors: string | null;
    }>(
      tenantId,
      `SELECT hcp_key, scope_tag, score_value, contributor_count, contributors
       FROM gold.hcp_target_score
       WHERE tenant_id = @tenantId
         AND scope_tag = @scopeTag
         AND hcp_key IN (${escIn})`,
      { scopeTag },
    );
    return rows.map((r) => ({
      hcp_key: r.hcp_key,
      scope_tag: r.scope_tag,
      score_value: r.score_value,
      contributor_count: r.contributor_count,
      contributors: parseContributors(r.contributors),
    }));
  } catch (err) {
    // Table may not exist yet (no Phase 2 build run) — return empty so
    // callers degrade gracefully. Log so it's visible in dev.
    console.error("loadHcpTargetScoresByKeys failed:", err);
    return [];
  }
}

// Load every scope_tag's score for a single HCP, including the synthetic
// '__all__' composite. Powers the HCP detail page's targeting score card —
// shows headline composite + per-therapy-area breakdown + top contributors.
// Returned in score_value DESC order so the highest-impact scopes lead.
export async function loadAllScoresForHcp(args: {
  tenantId: string;
  hcpKey: string;
}): Promise<HcpTargetScoreRow[]> {
  const { tenantId, hcpKey } = args;
  try {
    const rows = await queryFabric<{
      hcp_key: string;
      scope_tag: string;
      score_value: number;
      contributor_count: number;
      contributors: string | null;
    }>(
      tenantId,
      `SELECT hcp_key, scope_tag, score_value, contributor_count, contributors
       FROM gold.hcp_target_score
       WHERE tenant_id = @tenantId
         AND hcp_key = @hcpKey
       ORDER BY
         -- '__all__' first as the headline; then by score DESC for the breakdown
         CASE WHEN scope_tag = '__all__' THEN 0 ELSE 1 END,
         score_value DESC`,
      { hcpKey },
    );
    return rows.map((r) => ({
      hcp_key: r.hcp_key,
      scope_tag: r.scope_tag,
      score_value: r.score_value,
      contributor_count: r.contributor_count,
      contributors: parseContributors(r.contributors),
    }));
  } catch (err) {
    console.error("loadAllScoresForHcp failed:", err);
    return [];
  }
}

export type AffiliatedHcpScore = {
  hcp_key: string;
  name: string;
  specialty: string | null;
  tier: string | null;
  score_value: number;
  contributor_count: number;
  top_contributors: HcpTargetScoreContributor[];
  last_call_date: string | null;
};

// Top affiliated HCPs at an HCO ranked by composite targeting score.
// Powers the "High-targeting affiliated HCPs" card on /hcos/[hco_key] —
// surfaces WHY an HCO matters by showing the high-scoring physicians
// practicing there. Affiliation = HCP.primary_parent_hco_key matches.
//
// Includes last_call_date (any rep's most recent call) so the card can
// flag uncalled high-value HCPs distinct from already-engaged ones.
// Note: last_call here is tenant-wide (any rep), NOT scoped to viewer.
// The HCO page itself is shown to anyone in scope; this rollup is
// answering "what does this HCO offer," not "have I called them."
export async function loadTopScoringAffiliatedHcps(args: {
  tenantId: string;
  hcoKey: string;
  limit: number;
}): Promise<AffiliatedHcpScore[]> {
  const { tenantId, hcoKey, limit } = args;

  try {
    const rows = await queryFabric<{
      hcp_key: string;
      name: string;
      specialty: string | null;
      tier: string | null;
      score_value: number;
      contributor_count: number;
      contributors: string | null;
      last_call_date: string | null;
    }>(
      tenantId,
      `WITH last_calls AS (
         SELECT hcp_key, MAX(call_date) AS last_call_date
         FROM gold.fact_call
         WHERE tenant_id = @tenantId
           AND hcp_key IS NOT NULL
         GROUP BY hcp_key
       )
       SELECT TOP (@limit)
         h.hcp_key,
         h.name,
         h.specialty_primary AS specialty,
         h.tier,
         s.score_value,
         s.contributor_count,
         s.contributors,
         CONVERT(varchar(10), lc.last_call_date, 23) AS last_call_date
       FROM gold.dim_hcp h
       JOIN gold.hcp_target_score s
         ON s.tenant_id = h.tenant_id
         AND s.hcp_key = h.hcp_key
         AND s.scope_tag = '__all__'
       LEFT JOIN last_calls lc
         ON lc.hcp_key = h.hcp_key
       WHERE h.tenant_id = @tenantId
         AND h.primary_parent_hco_key = @hcoKey
       ORDER BY s.score_value DESC`,
      { hcoKey, limit },
    );

    return rows.map((r) => ({
      hcp_key: r.hcp_key,
      name: r.name,
      specialty: r.specialty,
      tier: r.tier,
      score_value: r.score_value,
      contributor_count: r.contributor_count,
      top_contributors: parseContributors(r.contributors).slice(0, 2),
      last_call_date: r.last_call_date,
    }));
  } catch (err) {
    console.error("loadTopScoringAffiliatedHcps failed:", err);
    return [];
  }
}

export type TopScoringHcpForRep = {
  hcp_key: string;
  name: string;
  specialty: string | null;
  primary_parent_hco_name: string | null;
  tier: string | null;
  score_value: number;
  contributor_count: number;
  contributors: HcpTargetScoreContributor[];
  last_call_date: string | null;
  never_called: boolean;
};

// Find the top-scoring HCPs in a rep's coverage (via territory bridge)
// that haven't been called recently. The "high-scoring but uncovered"
// list — the primary actionable surface this whole Phase 2 architecture
// exists to produce.
//
// Coverage definition: any HCP whose primary_parent_hco_key is an HCO
// in any territory the rep is currently assigned to. Mirrors the
// HCP-in-territory pattern used elsewhere (current-state; SCD2 deferred
// per project_owner_temporal_scd2_followup).
//
// Recency filter: HCPs called within `recentlyCalledSinceISO` are
// excluded — those are already engaged. Returns 0 calls = "never_called"
// flag for stronger LLM signaling vs "lapsed."
export async function loadTopScoringUncalledHcpsForRep(args: {
  tenantId: string;
  repUserKey: string;
  recentlyCalledSinceISO: string;
  limit: number;
  scopeTag?: string;
}): Promise<TopScoringHcpForRep[]> {
  const {
    tenantId,
    repUserKey,
    recentlyCalledSinceISO,
    limit,
    scopeTag = ALL_SCOPE,
  } = args;

  try {
    const rows = await queryFabric<{
      hcp_key: string;
      name: string;
      specialty: string | null;
      primary_parent_hco_name: string | null;
      tier: string | null;
      score_value: number;
      contributor_count: number;
      contributors: string | null;
      last_call_date: string | null;
    }>(
      tenantId,
      // Step 1: rep's territories (mirrors loadRepCoverageHcos pattern).
      // Step 2: HCOs in those territories (rep's coverage HCO universe).
      // Step 3: HCPs whose primary_parent_hco_key joins to that universe.
      // Step 4: Join in target score + most-recent call date.
      // Step 5: Filter out HCPs called since recentlyCalledSinceISO.
      // Step 6: Order by score DESC, take top N.
      `WITH rep_territories AS (
         SELECT t.territory_key
         FROM gold.dim_user u
         JOIN silver.user_territory ut
           ON ut.tenant_id = u.tenant_id
           AND ut.user_id = u.veeva_user_id
           AND COALESCE(ut.status, '') IN ('', 'Active', 'active')
         JOIN gold.dim_territory t
           ON t.tenant_id = ut.tenant_id
           AND t.veeva_territory_id = ut.territory_id
         WHERE u.tenant_id = @tenantId AND u.user_key = @repUserKey
       ),
       coverage_hcos AS (
         SELECT DISTINCT bat.account_key AS hco_key
         FROM gold.bridge_account_territory bat
         WHERE bat.tenant_id = @tenantId
           AND bat.territory_key IN (SELECT territory_key FROM rep_territories)
       ),
       coverage_hcps AS (
         SELECT DISTINCT h.hcp_key, h.name, h.specialty_primary AS specialty,
                h.primary_parent_hco_name, h.tier
         FROM gold.dim_hcp h
         JOIN coverage_hcos c ON c.hco_key = h.primary_parent_hco_key
         WHERE h.tenant_id = @tenantId
       ),
       last_calls AS (
         SELECT hcp_key, MAX(call_date) AS last_call_date
         FROM gold.fact_call
         WHERE tenant_id = @tenantId
           AND hcp_key IS NOT NULL
         GROUP BY hcp_key
       )
       SELECT TOP (@limit)
         ch.hcp_key,
         ch.name,
         ch.specialty,
         ch.primary_parent_hco_name,
         ch.tier,
         s.score_value,
         s.contributor_count,
         s.contributors,
         CONVERT(varchar(10), lc.last_call_date, 23) AS last_call_date
       FROM coverage_hcps ch
       JOIN gold.hcp_target_score s
         ON s.tenant_id = @tenantId
         AND s.hcp_key = ch.hcp_key
         AND s.scope_tag = @scopeTag
       LEFT JOIN last_calls lc
         ON lc.hcp_key = ch.hcp_key
       -- Exclude HCPs called recently (lc.last_call_date is the MOST
       -- recent; if it's after the cutoff, this HCP is already engaged).
       -- Direct ISO-string comparison matches loadUnderactiveCoverageHcos
       -- pattern; T-SQL implicitly casts the @param.
       WHERE lc.last_call_date IS NULL
          OR lc.last_call_date < @recentlyCalledSince
       ORDER BY s.score_value DESC`,
      {
        repUserKey,
        scopeTag,
        limit,
        recentlyCalledSince: recentlyCalledSinceISO,
      },
    );

    return rows.map((r) => ({
      hcp_key: r.hcp_key,
      name: r.name,
      specialty: r.specialty,
      primary_parent_hco_name: r.primary_parent_hco_name,
      tier: r.tier,
      score_value: r.score_value,
      contributor_count: r.contributor_count,
      contributors: parseContributors(r.contributors),
      last_call_date: r.last_call_date,
      never_called: r.last_call_date === null,
    }));
  } catch (err) {
    console.error("loadTopScoringUncalledHcpsForRep failed:", err);
    return [];
  }
}
