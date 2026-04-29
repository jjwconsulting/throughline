// "Suggested this week" recommendations for a rep, surfaced on
// /reps/[user_key]. LLM picks 3-5 specific HCPs/HCOs the rep should
// contact this week, with one-sentence reasons tied to the input
// data. Caches per (tenant, rep, pipeline_run_id) with a 4-hour
// generation rate-limit — same cost discipline as the synopsis card.
//
// Cache + dismissal lifecycle mirrors lib/synopsis.ts. The big
// difference: recommendations are anchored on the REP being viewed
// (not the viewer) so manager + rep + admin all see the same set.
//
// Architectural note: input-gathering builds an open-ended object
// with placeholder fields for future ML/analytical inputs (HCP
// scoring, forecasts, call NLP). Per
// `project_llm_input_extensibility` memory + the "Future inputs"
// section of docs/product/llm-expansion.md — adding new analytical
// surfaces becomes a matter of populating those fields, no LLM-side
// rewrite needed.

import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, schema } from "@throughline/db";
import { db } from "@/lib/db";
import {
  loadAccountMotion,
  loadWatchListAccounts,
  loadRepCoverageHcos,
} from "@/lib/sales";
import { loadTopHcps, repScope, type Scope } from "@/lib/interactions";
import { queryFabric } from "@/lib/fabric";
import {
  loadHcpTargetScoresByKeys,
  loadTopScoringUncalledHcpsForRep,
} from "@/lib/hcp-target-scores";
import { DEFAULT_FILTERS } from "@/app/(app)/dashboard/filters";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 600;
const MAX_ITEMS = 5;

// Mirrors lib/synopsis.ts. See `Synopsis tuning` section in
// docs/product/llm-expansion.md.
const MIN_HOURS_BETWEEN_GENERATIONS = 4;

export type RepRecommendationItem = {
  kind: "hcp" | "hco";
  key: string;
  label: string;
  reason: string;
  severity?: "high" | "medium" | "low";
};

export type RepRecommendationsResult =
  | {
      kind: "show";
      items: RepRecommendationItem[];
      pipelineRunId: string;
      generatedAt: Date;
    }
  | {
      kind: "hide";
      reason:
        | "no_run"
        | "no_changes"
        | "no_api_key"
        | "llm_error"
        | "rate_limited"
        | "bad_output";
      error?: string;
    };

export async function loadRepRecommendations(args: {
  tenantId: string;
  repUserKey: string;
  // Whether to make the LLM call if cache misses. Defaults true.
  // Caller can pass false to "peek" — return cached if present, else
  // hide. Useful for surfaces that don't want to pay for compute.
  generateOnMiss?: boolean;
}): Promise<RepRecommendationsResult> {
  const { tenantId, repUserKey, generateOnMiss = true } = args;

  // 1. Latest succeeded pipeline_run for tenant. Recommendations are
  //    anchored on this run; cache key includes its id.
  const latestRunRows = await db
    .select({
      id: schema.pipelineRun.id,
      finishedAt: schema.pipelineRun.finishedAt,
    })
    .from(schema.pipelineRun)
    .where(
      and(
        eq(schema.pipelineRun.tenantId, tenantId),
        eq(schema.pipelineRun.status, "succeeded"),
      ),
    )
    .orderBy(desc(schema.pipelineRun.finishedAt))
    .limit(1);
  const run = latestRunRows[0];
  if (!run || !run.finishedAt) {
    return { kind: "hide", reason: "no_run" };
  }

  // 2. Cache lookup. Per (tenant, rep, run) — viewer doesn't matter.
  const cachedRows = await db
    .select({
      body: schema.repRecommendationCache.body,
      generatedAt: schema.repRecommendationCache.generatedAt,
    })
    .from(schema.repRecommendationCache)
    .where(
      and(
        eq(schema.repRecommendationCache.tenantId, tenantId),
        eq(schema.repRecommendationCache.repUserKey, repUserKey),
        eq(schema.repRecommendationCache.pipelineRunId, run.id),
      ),
    )
    .limit(1);
  const cached = cachedRows[0];
  if (cached) {
    const items = parseItems(cached.body);
    if (items == null) return { kind: "hide", reason: "bad_output" };
    if (items.length === 0) return { kind: "hide", reason: "no_changes" };
    return {
      kind: "show",
      items,
      pipelineRunId: run.id,
      generatedAt: cached.generatedAt,
    };
  }

  if (!generateOnMiss) {
    return { kind: "hide", reason: "no_changes" };
  }

  // 3. Rate-limit. A new pipeline_run could land 30 min after the
  //    previous in prod; without this gate every refresh would
  //    trigger a fresh LLM call.
  const recentCacheRows = await db
    .select({ generatedAt: schema.repRecommendationCache.generatedAt })
    .from(schema.repRecommendationCache)
    .where(
      and(
        eq(schema.repRecommendationCache.tenantId, tenantId),
        eq(schema.repRecommendationCache.repUserKey, repUserKey),
      ),
    )
    .orderBy(desc(schema.repRecommendationCache.generatedAt))
    .limit(1);
  const mostRecent = recentCacheRows[0]?.generatedAt;
  if (mostRecent) {
    const hoursSince =
      (Date.now() - new Date(mostRecent).getTime()) / (1000 * 60 * 60);
    if (hoursSince < MIN_HOURS_BETWEEN_GENERATIONS) {
      return { kind: "hide", reason: "rate_limited" };
    }
  }

  // 4. Gather inputs. RLS scoped to the REP'S book (not viewer's),
  //    so a manager looking at one of their reps' pages gets the
  //    same recommendations the rep would.
  const inputs = await gatherRecommendationInputs(tenantId, repUserKey);
  const totalCandidates =
    inputs.coverage_hcos.length +
    inputs.rising_in_book.length +
    inputs.declining_in_book.length +
    inputs.watch_list_in_book.length;
  if (totalCandidates === 0) {
    return { kind: "hide", reason: "no_changes" };
  }

  const anthropic = getClient();
  if (!anthropic) return { kind: "hide", reason: "no_api_key" };

  const inputJson = JSON.stringify(inputs, null, 2);

  try {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Inputs:\n${inputJson}` }],
    });
    const block = res.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") {
      return {
        kind: "hide",
        reason: "llm_error",
        error: "no text block returned",
      };
    }
    const items = parseItems(block.text);
    if (items == null) {
      return {
        kind: "hide",
        reason: "bad_output",
        error: "could not parse JSON from LLM output",
      };
    }
    if (items.length === 0) {
      return { kind: "hide", reason: "no_changes" };
    }

    // Cache. JSON-stringify the items; keep the inputSnapshot for
    // prompt iteration / debugging.
    const bodyJson = JSON.stringify({ recommendations: items });
    await db
      .insert(schema.repRecommendationCache)
      .values({
        tenantId,
        repUserKey,
        pipelineRunId: run.id,
        body: bodyJson,
        inputSnapshot: inputJson,
      })
      .onConflictDoUpdate({
        target: [
          schema.repRecommendationCache.tenantId,
          schema.repRecommendationCache.repUserKey,
          schema.repRecommendationCache.pipelineRunId,
        ],
        set: {
          body: bodyJson,
          inputSnapshot: inputJson,
          generatedAt: new Date(),
        },
      });

    return {
      kind: "show",
      items,
      pipelineRunId: run.id,
      generatedAt: new Date(),
    };
  } catch (err) {
    return {
      kind: "hide",
      reason: "llm_error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Input gathering — open-ended object so future ML/analytical surfaces
// plug in as new top-level fields without LLM-side rewrites. Empty
// fields are intentionally left in the JSON so the prompt can hint
// "use any non-empty field that's relevant."
// ---------------------------------------------------------------------------

async function gatherRecommendationInputs(
  tenantId: string,
  repUserKey: string,
): Promise<RecommendationInputs> {
  const filters = { ...DEFAULT_FILTERS, range: "12w" as const };
  const repSqlScope: Scope = repScope(repUserKey);

  // 8-week window for underactive-coverage threshold. "No call in
  // last 8 weeks" balances tactical ("haven't touched lately") with
  // longer-term ("coverage gap"). Tunable.
  const underactiveSince = isoDateMinusDays(new Date(), 56);

  const [
    repMetaRows,
    coverage,
    rising,
    declining,
    watch,
    topCalled,
    underactiveCoverage,
    // Top-scoring uncalled HCPs in rep's coverage. The whole point of
    // tenant-custom attributes Phase 2 — surfaces "rep has explicit
    // coverage of these high-scoring HCPs but hasn't engaged in 8+ wks."
    // Returns [] when no scoring attributes are configured (Phase 2
    // builds run with no input → empty gold.hcp_target_score → empty
    // result), so this degrades gracefully on un-configured tenants.
    topScoringUncalled,
  ] = await Promise.all([
    queryFabric<{
      name: string;
      title: string | null;
      user_type: string | null;
    }>(
      tenantId,
      `SELECT TOP 1 name, title, user_type
       FROM gold.dim_user
       WHERE tenant_id = @tenantId AND user_key = @repUserKey`,
      { repUserKey },
    ),
    loadRepCoverageHcos(tenantId, repUserKey, 20),
    loadAccountMotion(tenantId, filters, "rising", 5, repSqlScope),
    loadAccountMotion(tenantId, filters, "declining", 5, repSqlScope),
    loadWatchListAccounts(tenantId, filters, 5, repSqlScope),
    loadTopHcps(tenantId, filters, repSqlScope),
    loadUnderactiveCoverageHcos(tenantId, repUserKey, underactiveSince, 10),
    loadTopScoringUncalledHcpsForRep({
      tenantId,
      repUserKey,
      recentlyCalledSinceISO: underactiveSince,
      limit: 10,
    }),
  ]);

  const repMeta = repMetaRows[0] ?? {
    name: "Unknown",
    title: null,
    user_type: null,
  };

  // Tier enrichment: pharma targets in tier order, so the LLM needs
  // tier on every entity to weight correctly. Batch-fetch tier for
  // every HCO and HCP that appears in any input category — one
  // round-trip total. dim_hco.tier and dim_hcp.tier are already in
  // gold; no schema changes needed.
  const allHcoKeys = Array.from(
    new Set(
      [
        ...rising.map((r) => r.hco_key),
        ...declining.map((r) => r.hco_key),
        ...watch.map((w) => w.hco_key),
        ...coverage.map((c) => c.hco_key),
      ].filter((k): k is string => typeof k === "string" && k.length > 0),
    ),
  );
  const allHcpKeys = Array.from(
    new Set(
      topCalled
        .slice(0, 5)
        .map((h) => h.hcp_key)
        .filter((k): k is string => typeof k === "string" && k.length > 0),
    ),
  );

  const escIn = (keys: string[]) =>
    keys.map((k) => `'${k.replace(/'/g, "''")}'`).join(",");

  // Batch enrichment: tier for every HCO/HCP in the input + composite
  // target score for every HCP in the input. Three parallel round-trips.
  // Target scores returns empty when no attribute mappings configured —
  // Phase-1-only tenants get the existing input shape with empty scores.
  const [hcoTierRows, hcpTierRows, hcpScores] = await Promise.all([
    allHcoKeys.length > 0
      ? queryFabric<{ hco_key: string; tier: string | null }>(
          tenantId,
          `SELECT hco_key, tier FROM gold.dim_hco
           WHERE tenant_id = @tenantId
             AND hco_key IN (${escIn(allHcoKeys)})`,
        )
      : Promise.resolve([]),
    allHcpKeys.length > 0
      ? queryFabric<{ hcp_key: string; tier: string | null }>(
          tenantId,
          `SELECT hcp_key, tier FROM gold.dim_hcp
           WHERE tenant_id = @tenantId
             AND hcp_key IN (${escIn(allHcpKeys)})`,
        )
      : Promise.resolve([]),
    loadHcpTargetScoresByKeys({ tenantId, hcpKeys: allHcpKeys }),
  ]);
  const hcoTierByKey = new Map(hcoTierRows.map((r) => [r.hco_key, r.tier]));
  const hcpTierByKey = new Map(hcpTierRows.map((r) => [r.hcp_key, r.tier]));
  const hcpScoreByKey = new Map(hcpScores.map((s) => [s.hcp_key, s]));
  const hcoTier = (k: string | null): string | null =>
    k ? (hcoTierByKey.get(k) ?? null) : null;
  const hcpTier = (k: string): string | null => hcpTierByKey.get(k) ?? null;
  const hcpScore = (k: string): number | null =>
    hcpScoreByKey.get(k)?.score_value ?? null;

  return {
    rep: {
      name: repMeta.name,
      title: repMeta.title,
      user_type: repMeta.user_type,
    },
    recent_activity: {
      window: "Last 12 weeks",
      top_5_called_hcps: topCalled.slice(0, 5).map((h) => ({
        hcp_key: h.hcp_key,
        name: h.name,
        specialty: h.specialty,
        tier: hcpTier(h.hcp_key),
        calls: h.calls,
        // Composite target score (0-100, NULL when no scoring data).
        // Lets the LLM reason about whether the rep is spending calls
        // on high-value HCPs ("top-called HCP scored only 12 of 100;
        // probably worth shifting attention").
        target_score: hcpScore(h.hcp_key),
      })),
    },
    coverage_hcos: coverage.slice(0, 20).map((c) => ({
      hco_key: c.hco_key,
      name: c.name,
      hco_type: c.hco_type,
      tier: hcoTier(c.hco_key),
      location: [c.city, c.state].filter(Boolean).join(", ") || null,
      is_primary_for_rep: c.is_primary_for_rep === 1,
    })),
    rising_in_book: rising.map((r) => ({
      hco_key: r.hco_key,
      name: r.name,
      tier: hcoTier(r.hco_key),
      delta_units: Math.round(r.units_delta),
      delta_pct: r.units_delta_pct == null ? null : Math.round(r.units_delta_pct),
      current_units: Math.round(r.units_period),
    })),
    declining_in_book: declining.map((r) => ({
      hco_key: r.hco_key,
      name: r.name,
      tier: hcoTier(r.hco_key),
      delta_units: Math.round(r.units_delta),
      delta_pct: r.units_delta_pct == null ? null : Math.round(r.units_delta_pct),
      current_units: Math.round(r.units_period),
    })),
    watch_list_in_book: watch.map((w) => ({
      hco_key: w.hco_key,
      name: w.name,
      tier: hcoTier(w.hco_key),
      prior_units: Math.round(w.units_prior),
      last_sale_date: w.last_sale_date,
    })),
    // HCOs in rep's coverage where ZERO calls landed in the last 8
    // weeks (calls rolled up from affiliated HCPs via
    // dim_hcp.primary_parent_hco_key — direct HCO-level calls are
    // rare in pharma; activity flows through HCP affiliation).
    // "never_called" flag distinguishes cold accounts from
    // previously-engaged-but-lapsed ones — both deserve a touch but
    // for different reasons.
    underactive_coverage: underactiveCoverage.map((u) => ({
      hco_key: u.hco_key,
      name: u.name,
      hco_type: u.hco_type,
      tier: u.tier,
      location: u.location,
      last_call_date: u.last_call_date,
      never_called: u.last_call_date == null,
    })),
    // ----- Plug-in points (per project_llm_input_extensibility) -----
    // hcp_target_scores: Phase 2 SHIPPED. Populated when the tenant has
    //   active attribute mappings + the silver/gold attribute pipeline
    //   has run. Empty otherwise (gracefully degrades).
    // hco_potential / forecasts / call_intelligence: still placeholders.
    // Adding a future analytical surface = populating one of these
    // arrays via its own loader; no LLM-side rewrite needed.
    predictions: {
      hcp_target_scores: topScoringUncalled.map((h) => ({
        hcp_key: h.hcp_key,
        name: h.name,
        specialty: h.specialty,
        primary_parent_hco_name: h.primary_parent_hco_name,
        tier: h.tier,
        score_value: h.score_value,
        contributor_count: h.contributor_count,
        // Top contributors (attribute name + raw value + normalized 0-100)
        // give the LLM material for specific reasoning ("top-decile
        // cisplatin volume + tier 1, no calls in 12 weeks").
        top_contributors: h.contributors.slice(0, 3).map((c) => ({
          attribute_name: c.attribute_name,
          raw_value: c.raw_value,
          normalized: c.normalized,
        })),
        last_call_date: h.last_call_date,
        never_called: h.never_called,
      })),
      hco_potential: [], // gold.hco_potential_score
    },
    forecasts: {
      territory_trajectories: [], // gold.fact_forecast
    },
    call_intelligence: {
      followups_promised: [], // gold.fact_call_nlp
    },
  };
}

type RecommendationInputs = {
  rep: { name: string; title: string | null; user_type: string | null };
  recent_activity: {
    window: string;
    top_5_called_hcps: {
      hcp_key: string;
      name: string;
      specialty: string | null;
      tier: string | null;
      calls: number;
      target_score: number | null;
    }[];
  };
  coverage_hcos: {
    hco_key: string;
    name: string;
    hco_type: string | null;
    tier: string | null;
    location: string | null;
    is_primary_for_rep: boolean;
  }[];
  rising_in_book: {
    hco_key: string;
    name: string;
    tier: string | null;
    delta_units: number;
    delta_pct: number | null;
    current_units: number;
  }[];
  declining_in_book: {
    hco_key: string;
    name: string;
    tier: string | null;
    delta_units: number;
    delta_pct: number | null;
    current_units: number;
  }[];
  watch_list_in_book: {
    hco_key: string;
    name: string;
    tier: string | null;
    prior_units: number;
    last_sale_date: string | null;
  }[];
  underactive_coverage: {
    hco_key: string;
    name: string;
    hco_type: string | null;
    tier: string | null;
    location: string | null;
    last_call_date: string | null;
    never_called: boolean;
  }[];
  predictions: {
    hcp_target_scores: {
      hcp_key: string;
      name: string;
      specialty: string | null;
      primary_parent_hco_name: string | null;
      tier: string | null;
      score_value: number;
      contributor_count: number;
      top_contributors: {
        attribute_name: string;
        raw_value: string;
        normalized: number;
      }[];
      last_call_date: string | null;
      never_called: boolean;
    }[];
    hco_potential: unknown[];
  };
  forecasts: {
    territory_trajectories: unknown[];
  };
  call_intelligence: {
    followups_promised: unknown[];
  };
};

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a commercial analytics assistant for a pharma sales rep. \
Your job is to suggest 3-5 specific HCPs or HCOs the rep should contact this week, ranked by importance.

Hard rules:
- Pick ONLY entities present in the input. NEVER invent a name or key.
- Each recommendation must include the entity's exact "hcp_key" or "hco_key" from the input as the "key" field.
- The "label" field is the entity's exact "name" from the input.
- Each "reason" is ONE concise sentence that cites specific numbers from the input \
(e.g. "Down 32% vs prior period and hasn't been called recently").
- TIER IS A PRIMARY WEIGHTING SIGNAL. Pharma targets in tier order: Tier 1 > Tier 2 > Tier 3 > Tier 4 > Unknown. \
A Tier 1 entity with a moderate gap/decline is MORE actionable than a Tier 2 entity with a severe one. \
Within the same priority category (declining, watch-list, etc.), pick the higher-tier entities first. \
When tier is missing/null/empty, treat as low-priority unless other signals are very strong.
- When citing tier in a "reason," include it explicitly ("Tier 1 academic medical center, declining 18%...").
- Category priority: declining accounts > watch-list re-engagement > predictions.hcp_target_scores (high-scoring HCPs in coverage with no recent calls — third-party scoring data shows these are the right targets) > underactive coverage (cold or lapsed HCOs the rep covers but hasn't touched in 8+ weeks) > rising accounts to capitalize > coverage HCOs without other signal. \
But TIER overrides category — a Tier 1 underactive coverage HCO beats a Tier 3 declining account.
- For "underactive_coverage" items: when "never_called" is true, the reason should highlight that the rep has explicit coverage but zero engagement. When false, cite the last_call_date as the gap.
- For "predictions.hcp_target_scores" items: these are HCPs in the rep's coverage with HIGH composite target scores (0-100) from third-party data (Komodo procedure volumes, Clarivate counts, etc.) but ZERO recent calls. The score_value + top_contributors give you the "why this matters" context. Cite a specific contributor when reasoning ("Top-decile cisplatin volume but no calls in 12 weeks"). Treat score_value >= 80 as high-priority regardless of tier.
- Avoid recommending an HCP that's in the top_5_called_hcps list — they're already engaged.
- If a future-input field (forecasts, call_intelligence) is non-empty, weight it appropriately. If it's empty, ignore it.
- Severity "high" = urgent (lost customer, big drop), "medium" = important (slowdown, gap), \
"low" = opportunity (rising, untouched).

Output ONLY a JSON object with this exact shape, no preamble, no markdown fences:
{
  "recommendations": [
    {
      "kind": "hcp" | "hco",
      "key": "<exact key from input>",
      "label": "<exact name from input>",
      "reason": "<one sentence with specific numbers>",
      "severity": "high" | "medium" | "low"
    }
  ]
}

If the input is mostly noise (no meaningful candidates), return {"recommendations": []}.`;

// ---------------------------------------------------------------------------
// Output parsing — defensive. Extracts JSON from LLM output, tolerates
// stray markdown fences or preamble text. Returns null on unrecoverable
// parse failures (caller surfaces "bad_output").
// ---------------------------------------------------------------------------

function parseItems(raw: string): RepRecommendationItem[] | null {
  if (typeof raw !== "string") return null;
  // LLMs sometimes wrap JSON in ```json fences despite instructions;
  // strip any fenced block first.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const candidate = fenced ? fenced[1]! : raw;
  // Find the JSON object substring (first { to last }) — handles
  // any stray preamble.
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  const json = candidate.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("recommendations" in parsed) ||
    !Array.isArray((parsed as { recommendations: unknown }).recommendations)
  ) {
    return null;
  }
  const items = (parsed as { recommendations: unknown[] }).recommendations;
  const validated: RepRecommendationItem[] = [];
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const rec = it as Record<string, unknown>;
    if (
      (rec.kind !== "hcp" && rec.kind !== "hco") ||
      typeof rec.key !== "string" ||
      typeof rec.label !== "string" ||
      typeof rec.reason !== "string"
    )
      continue;
    const sev =
      rec.severity === "high" ||
      rec.severity === "medium" ||
      rec.severity === "low"
        ? rec.severity
        : undefined;
    validated.push({
      kind: rec.kind,
      key: rec.key,
      label: rec.label,
      reason: rec.reason,
      severity: sev,
    });
    if (validated.length >= MAX_ITEMS) break;
  }
  return validated;
}

// Underactive coverage: HCOs in rep's territories with zero calls
// (rolled up via HCP affiliation) in the last N days. The roll-up
// uses dim_hcp.primary_parent_hco_key — a direct call to a HCP whose
// primary parent is HCO X counts as "activity at HCO X." This
// matches how pharma actually thinks about HCO engagement (calls
// happen at the HCP level; HCO is the institutional rollup).
//
// Excludes HCOs WITH any call in the window — only "cold or lapsed"
// coverage shows up here. Sort: never-called first (most actionable
// — rep has explicit coverage but zero engagement), then
// previously-called by oldest last-call first (longest gap).
type UnderactiveCoverageRow = {
  hco_key: string;
  name: string;
  hco_type: string | null;
  tier: string | null;
  location: string | null;
  last_call_date: string | null;
};

async function loadUnderactiveCoverageHcos(
  tenantId: string,
  repUserKey: string,
  windowStartIso: string,
  limit: number,
): Promise<UnderactiveCoverageRow[]> {
  try {
    return await queryFabric<UnderactiveCoverageRow>(
      tenantId,
      `WITH rep_coverage AS (
         SELECT DISTINCT b.account_key AS hco_key
         FROM gold.dim_user u
         JOIN silver.user_territory ut
           ON ut.tenant_id = u.tenant_id
           AND ut.user_id = u.veeva_user_id
           AND COALESCE(ut.status, '') IN ('', 'Active', 'active')
         JOIN gold.dim_territory t
           ON t.tenant_id = ut.tenant_id
           AND t.veeva_territory_id = ut.territory_id
         JOIN gold.bridge_account_territory b
           ON b.tenant_id = t.tenant_id
           AND b.territory_key = t.territory_key
         WHERE u.tenant_id = @tenantId AND u.user_key = @repUserKey
       ),
       hco_call_summary AS (
         -- Calls rolled up via HCP→HCO affiliation. recent_calls =
         -- count in window; last_call_date = max ever (across all
         -- history) so we can distinguish "never" from "lapsed."
         SELECT
           h.primary_parent_hco_key AS hco_key,
           SUM(CASE WHEN f.call_date >= @uacWindowStart THEN 1 ELSE 0 END) AS recent_calls,
           CONVERT(varchar(10), MAX(f.call_date), 23) AS last_call_date
         FROM gold.fact_call f
         JOIN gold.dim_hcp h
           ON h.hcp_key = f.hcp_key
           AND h.tenant_id = @tenantId
         WHERE f.tenant_id = @tenantId
           AND f.owner_user_key = @repUserKey
           AND h.primary_parent_hco_key IS NOT NULL
         GROUP BY h.primary_parent_hco_key
       )
       SELECT TOP ${limit}
         rc.hco_key,
         hco.name,
         hco.hco_type,
         hco.tier,
         CONCAT_WS(', ', NULLIF(hco.city, ''), NULLIF(hco.state, '')) AS location,
         hcs.last_call_date
       FROM rep_coverage rc
       JOIN gold.dim_hco hco
         ON hco.hco_key = rc.hco_key
         AND hco.tenant_id = @tenantId
       LEFT JOIN hco_call_summary hcs ON hcs.hco_key = rc.hco_key
       WHERE COALESCE(hcs.recent_calls, 0) = 0
       ORDER BY
         -- Tier first (Tier 1 > Tier 2 > ... > Unknown). Pharma
         -- targets in tier order; underactive Tier 1 is way more
         -- actionable than underactive Tier 4.
         CASE
           WHEN hco.tier IS NULL OR hco.tier = '' THEN 99
           WHEN hco.tier LIKE '%1%' THEN 1
           WHEN hco.tier LIKE '%2%' THEN 2
           WHEN hco.tier LIKE '%3%' THEN 3
           WHEN hco.tier LIKE '%4%' THEN 4
           ELSE 99
         END,
         -- Then never-called first (zero engagement is more
         -- actionable than lapsed)
         CASE WHEN hcs.last_call_date IS NULL THEN 0 ELSE 1 END,
         -- Then previously-called by oldest last-call first
         hcs.last_call_date ASC,
         hco.name`,
      { repUserKey, uacWindowStart: windowStartIso },
    );
  } catch (err) {
    console.error("loadUnderactiveCoverageHcos failed:", err);
    return [];
  }
}

function isoDateMinusDays(d: Date, days: number): string {
  const out = new Date(d);
  out.setUTCDate(out.getUTCDate() - days);
  return out.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Veeva account ID lookup — batches the Veeva account_id (the CRM record
// id) for each recommendation item so the action launchpad can build
// "Open in Veeva" deep links. Single round-trip across all items via
// IN-clause + UNION ALL between dim_hcp and dim_hco.
// ---------------------------------------------------------------------------

export async function loadVeevaAccountIdsForItems(args: {
  tenantId: string;
  items: { kind: "hcp" | "hco"; key: string }[];
}): Promise<Record<string, string>> {
  const { tenantId, items } = args;
  if (items.length === 0) return {};

  const hcpKeys = items.filter((i) => i.kind === "hcp").map((i) => i.key);
  const hcoKeys = items.filter((i) => i.kind === "hco").map((i) => i.key);
  const escIn = (keys: string[]) =>
    keys.map((k) => `'${k.replace(/'/g, "''")}'`).join(",");

  try {
    const parts: string[] = [];
    if (hcpKeys.length > 0) {
      parts.push(
        `SELECT 'hcp' AS kind, hcp_key AS surrogate_key, veeva_account_id
         FROM gold.dim_hcp
         WHERE tenant_id = @tenantId AND hcp_key IN (${escIn(hcpKeys)})`,
      );
    }
    if (hcoKeys.length > 0) {
      parts.push(
        `SELECT 'hco' AS kind, hco_key AS surrogate_key, veeva_account_id
         FROM gold.dim_hco
         WHERE tenant_id = @tenantId AND hco_key IN (${escIn(hcoKeys)})`,
      );
    }
    if (parts.length === 0) return {};

    const rows = await queryFabric<{
      kind: "hcp" | "hco";
      surrogate_key: string;
      veeva_account_id: string | null;
    }>(tenantId, parts.join("\nUNION ALL\n"));

    const out: Record<string, string> = {};
    for (const r of rows) {
      if (r.veeva_account_id) {
        out[`${r.kind}:${r.surrogate_key}`] = r.veeva_account_id;
      }
    }
    return out;
  } catch (err) {
    console.error("loadVeevaAccountIdsForItems failed:", err);
    return {};
  }
}

// ---------------------------------------------------------------------------
// Recommendation context — what to show when a rep expands a row.
//
// For HCO suggestions (the dominant case for underactive coverage):
//   - Top affiliated HCPs at this HCO with tier + specialty + last
//     call (by THIS rep)
//   - Mini sales trend (units over last 6 quarters at this HCO)
// For HCP suggestions (rare):
//   - Parent HCO summary + sales trend
//   - Recent calls to this HCP by this rep
//
// Pre-fetched at page render so expand is instant. ~5 batched
// queries total in parallel for typical 5-item recommendation list.
// ---------------------------------------------------------------------------

export type SalesQuarter = {
  bucket_label: string;
  bucket_start: string;
  net_units: number;
};

export type AffiliatedHcp = {
  hcp_key: string;
  name: string;
  tier: string | null;
  specialty: string | null;
  last_call_date: string | null;
};

export type ParentHcoSummary = {
  hco_key: string;
  name: string;
  hco_type: string | null;
};

export type RecentCall = {
  call_date: string;
  channel: string | null;
};

export type RecommendationContext =
  | {
      kind: "hco";
      affiliated_hcps: AffiliatedHcp[];
      sales_trend: SalesQuarter[];
    }
  | {
      kind: "hcp";
      parent_hco: ParentHcoSummary | null;
      parent_sales_trend: SalesQuarter[];
      recent_calls: RecentCall[];
    };

export async function loadRecommendationContexts(args: {
  tenantId: string;
  repUserKey: string;
  items: { kind: "hcp" | "hco"; key: string }[];
}): Promise<Map<string, RecommendationContext>> {
  const { tenantId, repUserKey, items } = args;
  const out = new Map<string, RecommendationContext>();
  if (items.length === 0) return out;

  const hcoKeys = Array.from(
    new Set(items.filter((i) => i.kind === "hco").map((i) => i.key)),
  );
  const hcpKeys = Array.from(
    new Set(items.filter((i) => i.kind === "hcp").map((i) => i.key)),
  );

  const escIn = (keys: string[]) =>
    keys.map((k) => `'${k.replace(/'/g, "''")}'`).join(",");

  // Six quarters back from today (covers ~18 months of trend).
  const sixQuartersAgo = isoDateMinusDays(new Date(), 18 * 30);

  // Plan: parent HCOs for HCP items resolve first so we know which
  // additional HCO keys to include in the sales-trend batch query.
  const parentHcoRows =
    hcpKeys.length > 0
      ? await queryFabric<{
          hcp_key: string;
          parent_hco_key: string | null;
          parent_hco_name: string | null;
          parent_hco_type: string | null;
        }>(
          tenantId,
          `SELECT
             h.hcp_key,
             h.primary_parent_hco_key AS parent_hco_key,
             hco.name                  AS parent_hco_name,
             hco.hco_type              AS parent_hco_type
           FROM gold.dim_hcp h
           LEFT JOIN gold.dim_hco hco
             ON hco.hco_key = h.primary_parent_hco_key
             AND hco.tenant_id = @tenantId
           WHERE h.tenant_id = @tenantId
             AND h.hcp_key IN (${escIn(hcpKeys)})`,
        )
      : [];

  const parentHcoByHcp = new Map<string, ParentHcoSummary | null>();
  const parentHcoKeys: string[] = [];
  for (const r of parentHcoRows) {
    if (r.parent_hco_key && r.parent_hco_name) {
      parentHcoByHcp.set(r.hcp_key, {
        hco_key: r.parent_hco_key,
        name: r.parent_hco_name,
        hco_type: r.parent_hco_type,
      });
      parentHcoKeys.push(r.parent_hco_key);
    } else {
      parentHcoByHcp.set(r.hcp_key, null);
    }
  }
  const allHcoKeysForTrend = Array.from(
    new Set([...hcoKeys, ...parentHcoKeys]),
  );

  // Three batched queries in parallel: affiliated HCPs (HCO items),
  // sales trends (all HCOs incl. parent HCOs), recent calls (HCP items).
  const [affiliatedRows, salesTrendRows, recentCallRows] = await Promise.all([
    hcoKeys.length > 0
      ? queryFabric<{
          hco_key: string;
          hcp_key: string;
          name: string;
          tier: string | null;
          specialty: string | null;
          last_call_date: string | null;
        }>(
          tenantId,
          `WITH ranked_hcps AS (
             SELECT
               h.primary_parent_hco_key AS hco_key,
               h.hcp_key,
               h.name,
               h.tier,
               h.specialty_primary AS specialty,
               ROW_NUMBER() OVER (
                 PARTITION BY h.primary_parent_hco_key
                 ORDER BY
                   CASE
                     WHEN h.tier IS NULL OR h.tier = '' THEN 99
                     WHEN h.tier LIKE '%1%' THEN 1
                     WHEN h.tier LIKE '%2%' THEN 2
                     WHEN h.tier LIKE '%3%' THEN 3
                     WHEN h.tier LIKE '%4%' THEN 4
                     ELSE 99
                   END,
                   h.name
               ) AS rn
             FROM gold.dim_hcp h
             WHERE h.tenant_id = @tenantId
               AND h.primary_parent_hco_key IN (${escIn(hcoKeys)})
               AND h.status = 'Active'
           ),
           top_hcps AS (
             SELECT * FROM ranked_hcps WHERE rn <= 8
           )
           SELECT
             th.hco_key,
             th.hcp_key,
             th.name,
             th.tier,
             th.specialty,
             CONVERT(varchar(10), MAX(f.call_date), 23) AS last_call_date
           FROM top_hcps th
           LEFT JOIN gold.fact_call f
             ON f.tenant_id = @tenantId
             AND f.hcp_key = th.hcp_key
             AND f.owner_user_key = @repUserKey
           GROUP BY th.hco_key, th.hcp_key, th.name, th.tier, th.specialty, th.rn
           ORDER BY th.hco_key, th.rn`,
          { repUserKey },
        )
      : Promise.resolve(
          [] as {
            hco_key: string;
            hcp_key: string;
            name: string;
            tier: string | null;
            specialty: string | null;
            last_call_date: string | null;
          }[],
        ),
    allHcoKeysForTrend.length > 0
      ? queryFabric<{
          hco_key: string;
          quarter_start: string;
          net_units: number;
        }>(
          tenantId,
          // Quarterly buckets — one row per (HCO, quarter). Caller
          // groups by hco_key in JS and renders sparkline / numeric
          // list.
          `SELECT
             account_key AS hco_key,
             CONVERT(varchar(10), DATEFROMPARTS(YEAR(transaction_date), ((MONTH(transaction_date) - 1) / 3) * 3 + 1, 1), 23) AS quarter_start,
             ROUND(SUM(signed_units), 0) AS net_units
           FROM gold.fact_sale
           WHERE tenant_id = @tenantId
             AND account_type = 'HCO'
             AND account_key IN (${escIn(allHcoKeysForTrend)})
             AND transaction_date >= @ctxSinceDate
           GROUP BY account_key, DATEFROMPARTS(YEAR(transaction_date), ((MONTH(transaction_date) - 1) / 3) * 3 + 1, 1)
           ORDER BY account_key, quarter_start`,
          { ctxSinceDate: sixQuartersAgo },
        )
      : Promise.resolve(
          [] as { hco_key: string; quarter_start: string; net_units: number }[],
        ),
    hcpKeys.length > 0
      ? queryFabric<{
          hcp_key: string;
          call_date: string;
          channel: string | null;
        }>(
          tenantId,
          `WITH ranked AS (
             SELECT
               f.hcp_key,
               CONVERT(varchar(10), f.call_date, 23) AS call_date,
               f.call_channel AS channel,
               ROW_NUMBER() OVER (PARTITION BY f.hcp_key ORDER BY f.call_date DESC) AS rn
             FROM gold.fact_call f
             WHERE f.tenant_id = @tenantId
               AND f.owner_user_key = @repUserKey
               AND f.hcp_key IN (${escIn(hcpKeys)})
           )
           SELECT hcp_key, call_date, channel
           FROM ranked
           WHERE rn <= 5
           ORDER BY hcp_key, call_date DESC`,
          { repUserKey },
        )
      : Promise.resolve(
          [] as {
            hcp_key: string;
            call_date: string;
            channel: string | null;
          }[],
        ),
  ]);

  // Group affiliated HCPs by hco_key.
  const affiliatedByHco = new Map<string, AffiliatedHcp[]>();
  for (const r of affiliatedRows) {
    const list = affiliatedByHco.get(r.hco_key) ?? [];
    list.push({
      hcp_key: r.hcp_key,
      name: r.name,
      tier: r.tier,
      specialty: r.specialty,
      last_call_date: r.last_call_date,
    });
    affiliatedByHco.set(r.hco_key, list);
  }

  // Group sales trend by hco_key. Quarters arrive in order so we
  // just push.
  const trendByHco = new Map<string, SalesQuarter[]>();
  for (const r of salesTrendRows) {
    const list = trendByHco.get(r.hco_key) ?? [];
    const start = new Date(r.quarter_start);
    const q = Math.floor(start.getUTCMonth() / 3) + 1;
    list.push({
      bucket_label: `Q${q} ${String(start.getUTCFullYear()).slice(-2)}`,
      bucket_start: r.quarter_start,
      net_units: Number(r.net_units) || 0,
    });
    trendByHco.set(r.hco_key, list);
  }

  // Group recent calls by hcp_key.
  const callsByHcp = new Map<string, RecentCall[]>();
  for (const r of recentCallRows) {
    const list = callsByHcp.get(r.hcp_key) ?? [];
    list.push({ call_date: r.call_date, channel: r.channel });
    callsByHcp.set(r.hcp_key, list);
  }

  // Assemble per-item context.
  for (const item of items) {
    const itemKey = `${item.kind}:${item.key}`;
    if (item.kind === "hco") {
      out.set(itemKey, {
        kind: "hco",
        affiliated_hcps: affiliatedByHco.get(item.key) ?? [],
        sales_trend: trendByHco.get(item.key) ?? [],
      });
    } else {
      const parent = parentHcoByHcp.get(item.key) ?? null;
      out.set(itemKey, {
        kind: "hcp",
        parent_hco: parent,
        parent_sales_trend: parent ? (trendByHco.get(parent.hco_key) ?? []) : [],
        recent_calls: callsByHcp.get(item.key) ?? [],
      });
    }
  }

  return out;
}

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}
