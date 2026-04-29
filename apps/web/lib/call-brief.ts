// Call brief generation — on-demand LLM surface for the action
// launchpad. Synthesizes a short prep note for a rep about to call
// (or visit) a specific HCP / HCO. Inputs:
//   - Entity meta (name, specialty/type, tier, parent HCO if HCP)
//   - Targeting score breakdown (composite + top contributors)
//   - This rep's recent calls to this entity (last 5)
//   - Recent sales motion at the entity (period vs prior + last sale)
// Output: 4-6 short bullets the rep can scan before the touch.
//
// Cached per (tenant, rep, entity_kind, entity_key, pipeline_run_id)
// — same cost-discipline pattern as synopsis + recommendations. Within
// one pipeline_run cycle, regenerating returns cached. New pipeline
// run forces fresh generation. 4-hour rate-limit floor across the
// (rep, entity) pair so even mid-cycle re-runs are gated.
//
// Triggered by the client via a server action; this module exposes the
// sync-style loadCallBrief that does the cache lookup + LLM call.

import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, schema } from "@throughline/db";
import { db } from "@/lib/db";
import { queryFabric } from "@/lib/fabric";
import { loadAllScoresForHcp } from "@/lib/hcp-target-scores";
import { parseLlmJson, LLM_CORE_RULES } from "@/lib/llm-utils";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 500;
const MIN_HOURS_BETWEEN_GENERATIONS = 4;

let _client: Anthropic | null | undefined;
function getClient(): Anthropic | null {
  if (_client !== undefined) return _client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    _client = null;
    return null;
  }
  _client = new Anthropic({ apiKey: key });
  return _client;
}

export type CallBrief = { bullets: string[] };

export type CallBriefResult =
  | { kind: "show"; brief: CallBrief; generatedAt: Date }
  | {
      kind: "error";
      reason:
        | "no_run"
        | "rate_limited"
        | "no_api_key"
        | "no_inputs"
        | "llm_error"
        | "bad_output"
        | "not_authorized";
      message?: string;
    };

export async function loadCallBrief(args: {
  tenantId: string;
  repUserKey: string;
  entityKind: "hcp" | "hco";
  entityKey: string;
  // When true, generate on cache miss. Server action sets this true;
  // a passive page-render reading from cache only would set false.
  generateOnMiss?: boolean;
}): Promise<CallBriefResult> {
  const {
    tenantId,
    repUserKey,
    entityKind,
    entityKey,
    generateOnMiss = true,
  } = args;

  // 1. Latest succeeded pipeline_run (cache key + freshness anchor)
  const latestRunRows = await db
    .select({ id: schema.pipelineRun.id })
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
  if (!run) return { kind: "error", reason: "no_run" };

  // 2. Cache lookup
  const cachedRows = await db
    .select({
      body: schema.callBriefCache.body,
      generatedAt: schema.callBriefCache.generatedAt,
    })
    .from(schema.callBriefCache)
    .where(
      and(
        eq(schema.callBriefCache.tenantId, tenantId),
        eq(schema.callBriefCache.repUserKey, repUserKey),
        eq(schema.callBriefCache.entityKind, entityKind),
        eq(schema.callBriefCache.entityKey, entityKey),
        eq(schema.callBriefCache.pipelineRunId, run.id),
      ),
    )
    .limit(1);
  const cached = cachedRows[0];
  if (cached) {
    const brief = parseBrief(cached.body);
    if (!brief) return { kind: "error", reason: "bad_output" };
    return { kind: "show", brief, generatedAt: cached.generatedAt };
  }
  if (!generateOnMiss) {
    // Caller wants cache-only read; report rate_limited so UI can show
    // a "click to generate" affordance.
    return { kind: "error", reason: "rate_limited" };
  }

  // 3. Rate-limit (any prior generation for this (rep, entity) within
  //    the last MIN_HOURS, regardless of pipeline_run, gates).
  const recentRows = await db
    .select({ generatedAt: schema.callBriefCache.generatedAt })
    .from(schema.callBriefCache)
    .where(
      and(
        eq(schema.callBriefCache.tenantId, tenantId),
        eq(schema.callBriefCache.repUserKey, repUserKey),
        eq(schema.callBriefCache.entityKind, entityKind),
        eq(schema.callBriefCache.entityKey, entityKey),
      ),
    )
    .orderBy(desc(schema.callBriefCache.generatedAt))
    .limit(1);
  const mostRecent = recentRows[0]?.generatedAt;
  if (mostRecent) {
    const hoursSince =
      (Date.now() - new Date(mostRecent).getTime()) / (1000 * 60 * 60);
    if (hoursSince < MIN_HOURS_BETWEEN_GENERATIONS) {
      return { kind: "error", reason: "rate_limited" };
    }
  }

  const anthropic = getClient();
  if (!anthropic) return { kind: "error", reason: "no_api_key" };

  // 4. Gather inputs
  const inputs =
    entityKind === "hcp"
      ? await gatherHcpInputs(tenantId, repUserKey, entityKey)
      : await gatherHcoInputs(tenantId, repUserKey, entityKey);
  if (!inputs) return { kind: "error", reason: "no_inputs" };

  const inputJson = JSON.stringify(inputs, null, 2);

  // 5. LLM call
  try {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Inputs:\n${inputJson}` }],
    });
    const block = res.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") {
      return { kind: "error", reason: "llm_error", message: "no text block" };
    }
    const brief = parseBrief(block.text);
    if (!brief) {
      return { kind: "error", reason: "bad_output", message: block.text.slice(0, 200) };
    }

    const bodyJson = JSON.stringify(brief);
    await db
      .insert(schema.callBriefCache)
      .values({
        tenantId,
        repUserKey,
        entityKind,
        entityKey,
        pipelineRunId: run.id,
        body: bodyJson,
        inputSnapshot: inputJson,
      })
      .onConflictDoUpdate({
        target: [
          schema.callBriefCache.tenantId,
          schema.callBriefCache.repUserKey,
          schema.callBriefCache.entityKind,
          schema.callBriefCache.entityKey,
          schema.callBriefCache.pipelineRunId,
        ],
        set: { body: bodyJson, inputSnapshot: inputJson, generatedAt: new Date() },
      });

    return { kind: "show", brief, generatedAt: new Date() };
  } catch (err) {
    return {
      kind: "error",
      reason: "llm_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Input gathering — kept open-ended objects per
// project_llm_input_extensibility. Future scoring / forecast / NLP
// fields slot in without prompt rewrites.
// ---------------------------------------------------------------------------

type HcpBriefInput = {
  kind: "hcp";
  hcp: {
    name: string;
    specialty: string | null;
    tier: string | null;
    primary_parent_hco_name: string | null;
  };
  targeting: {
    composite_score: number | null;
    top_contributors: { attribute_name: string; raw_value: string; normalized: number }[];
    per_scope: { scope_tag: string; score: number }[];
  };
  recent_calls_by_this_rep: {
    call_date: string;
    channel: string | null;
    call_type: string | null;
    is_drop_off: boolean;
    duration_minutes: number | null;
    detailed_products: string | null;
    materials_used: string | null;
    notes: string | null;
    pre_call_notes: string | null;
    next_call_notes: string | null;
  }[];
  parent_hco_sales_motion: SalesMotion | null;
};

type HcoBriefInput = {
  kind: "hco";
  hco: {
    name: string;
    hco_type: string | null;
    tier: string | null;
    location: string | null;
  };
  recent_calls_by_this_rep: {
    call_date: string;
    channel: string | null;
    hcp_name: string | null;
    call_type: string | null;
    is_drop_off: boolean;
    duration_minutes: number | null;
    detailed_products: string | null;
    materials_used: string | null;
    notes: string | null;
  }[];
  sales_motion: SalesMotion | null;
  top_affiliated_hcps_by_score: {
    name: string;
    specialty: string | null;
    tier: string | null;
    score: number;
    last_call_date: string | null;
  }[];
};

type SalesMotion = {
  net_units_period: number;
  net_units_prior: number;
  delta_pct: number | null;
  last_transaction_date: string | null;
};

async function gatherHcpInputs(
  tenantId: string,
  repUserKey: string,
  hcpKey: string,
): Promise<HcpBriefInput | null> {
  const [headerRows, scores, recentCalls, parentSalesRows] = await Promise.all([
    queryFabric<{
      name: string;
      specialty_primary: string | null;
      tier: string | null;
      primary_parent_hco_key: string | null;
      primary_parent_hco_name: string | null;
    }>(
      tenantId,
      `SELECT TOP 1 name, specialty_primary, tier,
         primary_parent_hco_key, primary_parent_hco_name
       FROM gold.dim_hcp
       WHERE tenant_id = @tenantId AND hcp_key = @hcpKey`,
      { hcpKey },
    ),
    loadAllScoresForHcp({ tenantId, hcpKey }),
    queryFabric<{
      call_date: string;
      channel: string | null;
      call_type: string | null;
      drop_off_visit: string | null;
      duration_minutes: number | null;
      detailed_products: string | null;
      materials_used: string | null;
      notes: string | null;
      pre_call_notes: string | null;
      next_call_notes: string | null;
    }>(
      tenantId,
      `SELECT TOP 5
         CONVERT(varchar(10), call_date, 23) AS call_date,
         call_channel AS channel,
         call_type,
         drop_off_visit,
         duration_minutes,
         detailed_products,
         materials_used,
         notes,
         pre_call_notes,
         next_call_notes
       FROM gold.fact_call
       WHERE tenant_id = @tenantId
         AND hcp_key = @hcpKey
         AND owner_user_key = @repUserKey
       ORDER BY call_date DESC`,
      { hcpKey, repUserKey },
    ),
    queryFabric<{
      net_units_period: number;
      net_units_prior: number;
      last_transaction_date: string | null;
    }>(
      tenantId,
      // Parent HCO sales motion — last 90 vs prior 90. Done inline
      // here so we don't have to factor a per-HCO motion loader; cheap.
      `WITH parent AS (
         SELECT primary_parent_hco_key
         FROM gold.dim_hcp
         WHERE tenant_id = @tenantId AND hcp_key = @hcpKey
       )
       SELECT
         COALESCE(SUM(CASE WHEN s.transaction_date >= DATEADD(day, -90, CAST(GETUTCDATE() AS DATE))
                           THEN s.signed_units ELSE 0 END), 0) AS net_units_period,
         COALESCE(SUM(CASE WHEN s.transaction_date < DATEADD(day, -90, CAST(GETUTCDATE() AS DATE))
                            AND s.transaction_date >= DATEADD(day, -180, CAST(GETUTCDATE() AS DATE))
                           THEN s.signed_units ELSE 0 END), 0) AS net_units_prior,
         CONVERT(varchar(10), MAX(s.transaction_date), 23) AS last_transaction_date
       FROM gold.fact_sale s
       JOIN parent p ON s.account_key = p.primary_parent_hco_key
       WHERE s.tenant_id = @tenantId`,
      { hcpKey },
    ),
  ]);

  const header = headerRows[0];
  if (!header) return null;

  const composite = scores.find((s) => s.scope_tag === "__all__") ?? null;
  const perScope = scores.filter((s) => s.scope_tag !== "__all__");

  return {
    kind: "hcp",
    hcp: {
      name: header.name,
      specialty: header.specialty_primary,
      tier: header.tier,
      primary_parent_hco_name: header.primary_parent_hco_name,
    },
    targeting: {
      composite_score: composite ? Math.round(composite.score_value) : null,
      top_contributors:
        composite?.contributors.slice(0, 3).map((c) => ({
          attribute_name: c.attribute_name,
          raw_value: c.raw_value,
          normalized: Math.round(c.normalized),
        })) ?? [],
      per_scope: perScope.map((s) => ({
        scope_tag: s.scope_tag,
        score: Math.round(s.score_value),
      })),
    },
    recent_calls_by_this_rep: recentCalls.map((c) => ({
      call_date: c.call_date,
      channel: c.channel,
      call_type: c.call_type,
      is_drop_off: isDropOff(c.drop_off_visit),
      duration_minutes: c.duration_minutes,
      detailed_products: c.detailed_products,
      materials_used: c.materials_used,
      notes: nonEmptyString(c.notes),
      pre_call_notes: nonEmptyString(c.pre_call_notes),
      next_call_notes: nonEmptyString(c.next_call_notes),
    })),
    parent_hco_sales_motion: salesMotionRow(parentSalesRows[0] ?? null),
  };
}

async function gatherHcoInputs(
  tenantId: string,
  repUserKey: string,
  hcoKey: string,
): Promise<HcoBriefInput | null> {
  const [headerRows, recentCalls, salesRows, affiliatedScores] = await Promise.all([
    queryFabric<{
      name: string;
      hco_type: string | null;
      tier: string | null;
      city: string | null;
      state: string | null;
    }>(
      tenantId,
      `SELECT TOP 1 name, hco_type, tier, city, state
       FROM gold.dim_hco
       WHERE tenant_id = @tenantId AND hco_key = @hcoKey`,
      { hcoKey },
    ),
    queryFabric<{
      call_date: string;
      channel: string | null;
      hcp_name: string | null;
      call_type: string | null;
      drop_off_visit: string | null;
      duration_minutes: number | null;
      detailed_products: string | null;
      materials_used: string | null;
      notes: string | null;
    }>(
      tenantId,
      // HCO has no direct hcp_key on fact_call (per known gap in
      // project_gold_fact_call_followups), so roll up via HCP affiliation.
      `SELECT TOP 5
         CONVERT(varchar(10), f.call_date, 23) AS call_date,
         f.call_channel AS channel,
         h.name AS hcp_name,
         f.call_type,
         f.drop_off_visit,
         f.duration_minutes,
         f.detailed_products,
         f.materials_used,
         f.notes
       FROM gold.fact_call f
       JOIN gold.dim_hcp h
         ON h.hcp_key = f.hcp_key
         AND h.tenant_id = f.tenant_id
       WHERE f.tenant_id = @tenantId
         AND f.owner_user_key = @repUserKey
         AND h.primary_parent_hco_key = @hcoKey
       ORDER BY f.call_date DESC`,
      { hcoKey, repUserKey },
    ),
    queryFabric<{
      net_units_period: number;
      net_units_prior: number;
      last_transaction_date: string | null;
    }>(
      tenantId,
      `SELECT
         COALESCE(SUM(CASE WHEN transaction_date >= DATEADD(day, -90, CAST(GETUTCDATE() AS DATE))
                           THEN signed_units ELSE 0 END), 0) AS net_units_period,
         COALESCE(SUM(CASE WHEN transaction_date < DATEADD(day, -90, CAST(GETUTCDATE() AS DATE))
                            AND transaction_date >= DATEADD(day, -180, CAST(GETUTCDATE() AS DATE))
                           THEN signed_units ELSE 0 END), 0) AS net_units_prior,
         CONVERT(varchar(10), MAX(transaction_date), 23) AS last_transaction_date
       FROM gold.fact_sale
       WHERE tenant_id = @tenantId
         AND account_key = @hcoKey`,
      { hcoKey },
    ),
    queryFabric<{
      name: string;
      specialty: string | null;
      tier: string | null;
      score_value: number;
      last_call_date: string | null;
    }>(
      tenantId,
      `WITH last_calls AS (
         SELECT hcp_key, MAX(call_date) AS last_call_date
         FROM gold.fact_call
         WHERE tenant_id = @tenantId AND hcp_key IS NOT NULL
         GROUP BY hcp_key
       )
       SELECT TOP 5
         h.name,
         h.specialty_primary AS specialty,
         h.tier,
         s.score_value,
         CONVERT(varchar(10), lc.last_call_date, 23) AS last_call_date
       FROM gold.dim_hcp h
       JOIN gold.hcp_target_score s
         ON s.tenant_id = h.tenant_id
         AND s.hcp_key = h.hcp_key
         AND s.scope_tag = '__all__'
       LEFT JOIN last_calls lc ON lc.hcp_key = h.hcp_key
       WHERE h.tenant_id = @tenantId
         AND h.primary_parent_hco_key = @hcoKey
       ORDER BY s.score_value DESC`,
      { hcoKey },
    ),
  ]);

  const header = headerRows[0];
  if (!header) return null;

  return {
    kind: "hco",
    hco: {
      name: header.name,
      hco_type: header.hco_type,
      tier: header.tier,
      location: [header.city, header.state].filter(Boolean).join(", ") || null,
    },
    recent_calls_by_this_rep: recentCalls.map((c) => ({
      call_date: c.call_date,
      channel: c.channel,
      hcp_name: c.hcp_name,
      call_type: c.call_type,
      is_drop_off: isDropOff(c.drop_off_visit),
      duration_minutes: c.duration_minutes,
      detailed_products: c.detailed_products,
      materials_used: c.materials_used,
      notes: nonEmptyString(c.notes),
    })),
    sales_motion: salesMotionRow(salesRows[0] ?? null),
    top_affiliated_hcps_by_score: affiliatedScores.map((a) => ({
      name: a.name,
      specialty: a.specialty,
      tier: a.tier,
      score: Math.round(a.score_value),
      last_call_date: a.last_call_date,
    })),
  };
}

function isDropOff(value: string | null): boolean {
  if (!value) return false;
  return value.toLowerCase() === "true";
}

function nonEmptyString(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function salesMotionRow(
  row: {
    net_units_period: number;
    net_units_prior: number;
    last_transaction_date: string | null;
  } | null,
): SalesMotion | null {
  if (!row) return null;
  // Hide the section entirely when no sales activity at all — keeps
  // brief inputs lean for HCPs at sales-irrelevant accounts.
  if (
    row.net_units_period === 0 &&
    row.net_units_prior === 0 &&
    !row.last_transaction_date
  ) {
    return null;
  }
  const period = Math.round(row.net_units_period);
  const prior = Math.round(row.net_units_prior);
  const delta_pct =
    prior !== 0 ? Math.round(((period - prior) / Math.abs(prior)) * 100) : null;
  return {
    net_units_period: period,
    net_units_prior: prior,
    delta_pct,
    last_transaction_date: row.last_transaction_date,
  };
}

// ---------------------------------------------------------------------------
// Prompt + parsing
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a commercial analytics assistant generating a short pre-call brief for a pharma sales rep.

${LLM_CORE_RULES}

Surface-specific rules:
- Output 4-6 BULLETS. Each bullet is ONE sentence, ~12-20 words.
- Order bullets by importance: targeting signal first (if score is high), then sales motion, then engagement gap, then closing/relationship.
- For HCPs with high targeting scores, cite the score + a top contributor ("Composite score 87 driven by top-decile cisplatin volume — strong Pedmark fit").
- For underactive engagement, cite the gap explicitly ("Last call was 9 weeks ago" or "Never called by this rep").
- For HCO calls, mention the affiliated HCPs that should be the focus when relevant ("Dr. Smith (T1, score 91) is the highest-value HCP here").
- DROP-OFF VS LIVE: when "is_drop_off" is true on past calls, those were logistical drops (rep dropped materials without seeing the HCP) — NOT real conversations. Distinguish "you dropped materials 3 times but haven't had a live conversation" if relevant.
- NOTES + PRE/NEXT-CALL NOTES: when present on recent_calls_by_this_rep, these are the rep's own written context. Quote or paraphrase specific items ("you flagged dosing concerns last visit") — this is the highest-signal input when it exists.
- PRODUCTS + MATERIALS: detailed_products + materials_used on past calls show what's been discussed. Surface continuity ("you've detailed Pedmark every visit") or gaps ("never discussed [X] despite high relevance").
- Avoid vague filler ("good engagement opportunity"). Every bullet should carry an actionable specific.

Output ONLY a JSON object with this exact shape, no preamble, no markdown fences:
{ "bullets": ["...", "...", "..."] }

If the input lacks any meaningful signal, return { "bullets": [] }.`;

function parseBrief(raw: string): CallBrief | null {
  return parseLlmJson<CallBrief>(raw, (parsed) => {
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("bullets" in parsed) ||
      !Array.isArray((parsed as { bullets: unknown }).bullets)
    ) {
      return null;
    }
    const bullets = (parsed as { bullets: unknown[] }).bullets.filter(
      (b): b is string => typeof b === "string" && b.trim().length > 0,
    );
    return { bullets };
  });
}
