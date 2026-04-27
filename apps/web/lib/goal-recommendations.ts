// Goal recommendation engine. Per the project_goals_product_thesis memory:
// our wedge is auto-recommending the 80% of goals clients have no real
// conviction about. The form / upload arrives pre-populated with these
// suggestions; admin scans + tweaks the conviction-heavy 20% they care about.
//
// v1 supports the calls metric at rep entity for month/quarter periods.
// Future: units/revenue (needs fact_sales), reach_pct/frequency, territory/
// region/tier entity types. The shape generalizes.

import { queryFabric } from "@/lib/fabric";

export type RecommendationMethod =
  | "trend_with_peer_floor"
  | "peer_average"
  | "historical_average"
  | "insufficient_data";

export type GoalRecommendationContext = {
  // Last N periods of actuals for this entity, oldest → newest.
  historical: { period_label: string; value: number }[];
  // The same period's median across peer entities (other reps in the tenant).
  peer_median: number | null;
  // Implied period-over-period growth rate from the historical series. Null if
  // insufficient data (<2 periods).
  growth_rate_pct: number | null;
  // How the recommendation was computed.
  method: RecommendationMethod;
};

export type GoalRecommendation = {
  value: number;
  unit: string;
  context: GoalRecommendationContext;
};

// ---------------------------------------------------------------------------
// Calls metric, rep entity
// ---------------------------------------------------------------------------

export async function recommendCallGoalForRep(
  tenantId: string,
  userKey: string,
  periodStart: string, // ISO date — the period we're recommending FOR
  periodEnd: string,
): Promise<GoalRecommendation> {
  const periodDays = daysBetween(periodStart, periodEnd) + 1;
  // Pull the rep's historical equivalent-length windows ending immediately
  // before periodStart. Look back 4 periods so we have a trend.
  const historical = await loadRepHistoricalCalls(
    tenantId,
    userKey,
    periodStart,
    periodDays,
    4,
  );
  const peerMedian = await loadPeerMedianCalls(
    tenantId,
    userKey,
    periodStart,
    periodDays,
  );

  return synthesize({
    historical,
    peerMedian,
    unit: "count",
  });
}

// ---------------------------------------------------------------------------
// Synthesis: pick a method, compute the value, attach the rationale
// ---------------------------------------------------------------------------

function synthesize(args: {
  historical: { period_label: string; value: number }[];
  peerMedian: number | null;
  unit: string;
}): GoalRecommendation {
  const { historical, peerMedian, unit } = args;

  // Insufficient history: fall back to peer median if we have it; else
  // surface "insufficient data" so the UI can show "no recommendation, set
  // manually."
  if (historical.length === 0) {
    if (peerMedian != null) {
      return {
        value: round(peerMedian),
        unit,
        context: {
          historical: [],
          peer_median: peerMedian,
          growth_rate_pct: null,
          method: "peer_average",
        },
      };
    }
    return {
      value: 0,
      unit,
      context: {
        historical: [],
        peer_median: null,
        growth_rate_pct: null,
        method: "insufficient_data",
      },
    };
  }

  // Single historical period: project flat (no trend signal).
  if (historical.length === 1) {
    return {
      value: round(historical[0]!.value),
      unit,
      context: {
        historical,
        peer_median: peerMedian,
        growth_rate_pct: null,
        method: "historical_average",
      },
    };
  }

  // 2+ periods: compute period-over-period growth rate (avg of pairwise
  // deltas), project the most recent value forward by that rate.
  const growthRatePct = avgGrowthRatePct(historical.map((h) => h.value));
  const latest = historical[historical.length - 1]!.value;
  const projected = latest * (1 + growthRatePct / 100);

  // Floor at the peer median to avoid suggesting goals so low that a rep
  // could coast. Peer median is the conservative "what would similar reps
  // do" benchmark.
  const value =
    peerMedian != null && projected < peerMedian ? peerMedian : projected;

  return {
    value: round(value),
    unit,
    context: {
      historical,
      peer_median: peerMedian,
      growth_rate_pct: growthRatePct,
      method: "trend_with_peer_floor",
    },
  };
}

// ---------------------------------------------------------------------------
// Batched: recommend call goals for many reps in a single round trip.
// Used by the /admin/goals form, which renders a row per rep — calling the
// per-rep loader 100x would mean 200+ Fabric queries and a 30s page load.
// Two batched queries instead: one for all reps' historical actuals across
// N windows, one for all reps' last-period totals (to derive peer median).
// JS synthesizes per-rep recommendations in memory.
// ---------------------------------------------------------------------------

export type RepRecommendation = {
  user_key: string;
  recommendation: GoalRecommendation;
};

export async function recommendCallGoalsForReps(
  tenantId: string,
  userKeys: string[],
  periodStart: string,
  periodEnd: string,
): Promise<RepRecommendation[]> {
  if (userKeys.length === 0) return [];
  const periodDays = daysBetween(periodStart, periodEnd) + 1;
  const lookback = 4;

  const [historicalRows, peerRows] = await Promise.all([
    loadHistoricalCallsForReps(
      tenantId,
      userKeys,
      periodStart,
      periodDays,
      lookback,
    ),
    loadLastPeriodCallsForReps(tenantId, userKeys, periodStart, periodDays),
  ]);

  // Bucket historical by rep, sorted oldest → newest.
  const histByRep = new Map<string, { period_label: string; value: number }[]>();
  for (const row of historicalRows) {
    if (row.calls === 0) continue; // skip zero windows (rep wasn't active)
    const list = histByRep.get(row.user_key) ?? [];
    list.push({ period_label: row.window_start, value: row.calls });
    histByRep.set(row.user_key, list);
  }
  for (const list of histByRep.values()) {
    list.sort((a, b) => a.period_label.localeCompare(b.period_label));
  }

  // Peer median computed once over the population (excluding-self adjustment
  // is negligible at scale; per-rep medians would require N×N work).
  const peerValues = peerRows.map((r) => r.peer_calls).filter((v) => v > 0);
  const peerMedian = median(peerValues);

  return userKeys.map((userKey) => ({
    user_key: userKey,
    recommendation: synthesize({
      historical: histByRep.get(userKey) ?? [],
      peerMedian,
      unit: "count",
    }),
  }));
}

// ---------------------------------------------------------------------------
// Units metric, rep entity. Mirrors recommendCallGoalsForReps but reads
// from gold.fact_sale (rep_user_key + signed_units) instead of fact_call.
// Same shape returned so the goals form / CSV / lookup code can stay
// metric-agnostic.
// ---------------------------------------------------------------------------

export async function recommendUnitsGoalsForReps(
  tenantId: string,
  userKeys: string[],
  periodStart: string,
  periodEnd: string,
): Promise<RepRecommendation[]> {
  if (userKeys.length === 0) return [];
  const periodDays = daysBetween(periodStart, periodEnd) + 1;
  const lookback = 4;

  const [historicalRows, peerRows] = await Promise.all([
    loadHistoricalUnitsForReps(
      tenantId,
      userKeys,
      periodStart,
      periodDays,
      lookback,
    ),
    loadLastPeriodUnitsForReps(tenantId, userKeys, periodStart, periodDays),
  ]);

  const histByRep = new Map<string, { period_label: string; value: number }[]>();
  for (const row of historicalRows) {
    if (row.units === 0) continue;
    const list = histByRep.get(row.user_key) ?? [];
    list.push({ period_label: row.window_start, value: row.units });
    histByRep.set(row.user_key, list);
  }
  for (const list of histByRep.values()) {
    list.sort((a, b) => a.period_label.localeCompare(b.period_label));
  }

  const peerValues = peerRows.map((r) => r.peer_units).filter((v) => v > 0);
  const peerMedian = median(peerValues);

  return userKeys.map((userKey) => ({
    user_key: userKey,
    recommendation: synthesize({
      historical: histByRep.get(userKey) ?? [],
      peerMedian,
      unit: "units",
    }),
  }));
}

async function loadHistoricalUnitsForReps(
  tenantId: string,
  userKeys: string[],
  periodStart: string,
  periodDays: number,
  lookback: number,
): Promise<{ user_key: string; window_start: string; units: number }[]> {
  const userKeyValues = userKeys
    .map((k) => `('${k.replace(/'/g, "''")}')`)
    .join(",");
  const windowValues = Array.from({ length: lookback }, (_, i) => `(${i})`).join(
    ",",
  );
  return queryFabric<{ user_key: string; window_start: string; units: number }>(
    tenantId,
    `WITH anchor AS (
       SELECT DATEADD(DAY, -1, CAST(@periodStart AS date)) AS prev_end
     ),
     windows AS (
       SELECT
         DATEADD(DAY, -((n + 1) * @periodDays - 1), a.prev_end) AS window_start,
         DATEADD(DAY, -(n * @periodDays), a.prev_end) AS window_end
       FROM anchor a
       CROSS JOIN (VALUES ${windowValues}) AS w(n)
     ),
     reps AS (
       SELECT user_key FROM (VALUES ${userKeyValues}) AS u(user_key)
     )
     SELECT
       r.user_key,
       CONVERT(varchar(10), w.window_start, 23) AS window_start,
       COALESCE(ROUND(SUM(f.signed_units), 0), 0) AS units
     FROM reps r
     CROSS JOIN windows w
     LEFT JOIN gold.fact_sale f
       ON f.tenant_id = @tenantId
       AND f.rep_user_key = r.user_key
       AND f.transaction_date >= w.window_start
       AND f.transaction_date <= w.window_end
     GROUP BY r.user_key, w.window_start
     ORDER BY r.user_key, w.window_start`,
    { periodStart, periodDays },
  );
}

async function loadLastPeriodUnitsForReps(
  tenantId: string,
  userKeys: string[],
  periodStart: string,
  periodDays: number,
): Promise<{ user_key: string; peer_units: number }[]> {
  const userKeyValues = userKeys
    .map((k) => `('${k.replace(/'/g, "''")}')`)
    .join(",");
  return queryFabric<{ user_key: string; peer_units: number }>(
    tenantId,
    `WITH reps AS (
       SELECT user_key FROM (VALUES ${userKeyValues}) AS u(user_key)
     )
     SELECT
       r.user_key,
       COALESCE(ROUND(SUM(f.signed_units), 0), 0) AS peer_units
     FROM reps r
     LEFT JOIN gold.fact_sale f
       ON f.tenant_id = @tenantId
       AND f.rep_user_key = r.user_key
       AND f.transaction_date >= DATEADD(DAY, -@periodDays, CAST(@periodStart AS date))
       AND f.transaction_date < CAST(@periodStart AS date)
     GROUP BY r.user_key`,
    { periodStart, periodDays },
  );
}

// ---------------------------------------------------------------------------
// Units metric, TERRITORY entity. The pharma-standard shape for sales
// goals — territories represent stable market potential; reps come and
// go but the territory's number stays. Mirrors the rep-units recommender
// but groups by territory_key instead of rep_user_key.
// ---------------------------------------------------------------------------

export type EntityRecommendation = {
  entity_id: string;
  recommendation: GoalRecommendation;
};

export async function recommendUnitsGoalsForTerritories(
  tenantId: string,
  territoryKeys: string[],
  periodStart: string,
  periodEnd: string,
): Promise<EntityRecommendation[]> {
  if (territoryKeys.length === 0) return [];
  const periodDays = daysBetween(periodStart, periodEnd) + 1;
  const lookback = 4;

  const [historicalRows, peerRows] = await Promise.all([
    loadHistoricalUnitsForTerritories(
      tenantId,
      territoryKeys,
      periodStart,
      periodDays,
      lookback,
    ),
    loadLastPeriodUnitsForTerritories(
      tenantId,
      territoryKeys,
      periodStart,
      periodDays,
    ),
  ]);

  const histByTerr = new Map<
    string,
    { period_label: string; value: number }[]
  >();
  for (const row of historicalRows) {
    if (row.units === 0) continue;
    const list = histByTerr.get(row.territory_key) ?? [];
    list.push({ period_label: row.window_start, value: row.units });
    histByTerr.set(row.territory_key, list);
  }
  for (const list of histByTerr.values()) {
    list.sort((a, b) => a.period_label.localeCompare(b.period_label));
  }

  const peerValues = peerRows.map((r) => r.peer_units).filter((v) => v > 0);
  const peerMedian = median(peerValues);

  return territoryKeys.map((territoryKey) => ({
    entity_id: territoryKey,
    recommendation: synthesize({
      historical: histByTerr.get(territoryKey) ?? [],
      peerMedian,
      unit: "units",
    }),
  }));
}

async function loadHistoricalUnitsForTerritories(
  tenantId: string,
  territoryKeys: string[],
  periodStart: string,
  periodDays: number,
  lookback: number,
): Promise<{ territory_key: string; window_start: string; units: number }[]> {
  const territoryValues = territoryKeys
    .map((k) => `('${k.replace(/'/g, "''")}')`)
    .join(",");
  const windowValues = Array.from({ length: lookback }, (_, i) => `(${i})`).join(
    ",",
  );
  return queryFabric<{
    territory_key: string;
    window_start: string;
    units: number;
  }>(
    tenantId,
    `WITH anchor AS (
       SELECT DATEADD(DAY, -1, CAST(@periodStart AS date)) AS prev_end
     ),
     windows AS (
       SELECT
         DATEADD(DAY, -((n + 1) * @periodDays - 1), a.prev_end) AS window_start,
         DATEADD(DAY, -(n * @periodDays), a.prev_end) AS window_end
       FROM anchor a
       CROSS JOIN (VALUES ${windowValues}) AS w(n)
     ),
     territories AS (
       SELECT territory_key FROM (VALUES ${territoryValues}) AS t(territory_key)
     )
     SELECT
       t.territory_key,
       CONVERT(varchar(10), w.window_start, 23) AS window_start,
       COALESCE(ROUND(SUM(f.signed_units), 0), 0) AS units
     FROM territories t
     CROSS JOIN windows w
     LEFT JOIN gold.fact_sale f
       ON f.tenant_id = @tenantId
       AND f.territory_key = t.territory_key
       AND f.transaction_date >= w.window_start
       AND f.transaction_date <= w.window_end
     GROUP BY t.territory_key, w.window_start
     ORDER BY t.territory_key, w.window_start`,
    { periodStart, periodDays },
  );
}

async function loadLastPeriodUnitsForTerritories(
  tenantId: string,
  territoryKeys: string[],
  periodStart: string,
  periodDays: number,
): Promise<{ territory_key: string; peer_units: number }[]> {
  const territoryValues = territoryKeys
    .map((k) => `('${k.replace(/'/g, "''")}')`)
    .join(",");
  return queryFabric<{ territory_key: string; peer_units: number }>(
    tenantId,
    `WITH territories AS (
       SELECT territory_key FROM (VALUES ${territoryValues}) AS t(territory_key)
     )
     SELECT
       t.territory_key,
       COALESCE(ROUND(SUM(f.signed_units), 0), 0) AS peer_units
     FROM territories t
     LEFT JOIN gold.fact_sale f
       ON f.tenant_id = @tenantId
       AND f.territory_key = t.territory_key
       AND f.transaction_date >= DATEADD(DAY, -@periodDays, CAST(@periodStart AS date))
       AND f.transaction_date < CAST(@periodStart AS date)
     GROUP BY t.territory_key`,
    { periodStart, periodDays },
  );
}

async function loadHistoricalCallsForReps(
  tenantId: string,
  userKeys: string[],
  periodStart: string,
  periodDays: number,
  lookback: number,
): Promise<{ user_key: string; window_start: string; calls: number }[]> {
  const userKeyValues = userKeys
    .map((k) => `('${k.replace(/'/g, "''")}')`)
    .join(",");
  const windowValues = Array.from({ length: lookback }, (_, i) => `(${i})`).join(
    ",",
  );
  return queryFabric<{ user_key: string; window_start: string; calls: number }>(
    tenantId,
    `WITH anchor AS (
       SELECT DATEADD(DAY, -1, CAST(@periodStart AS date)) AS prev_end
     ),
     windows AS (
       SELECT
         DATEADD(DAY, -((n + 1) * @periodDays - 1), a.prev_end) AS window_start,
         DATEADD(DAY, -(n * @periodDays), a.prev_end) AS window_end
       FROM anchor a
       CROSS JOIN (VALUES ${windowValues}) AS w(n)
     ),
     reps AS (
       SELECT user_key FROM (VALUES ${userKeyValues}) AS u(user_key)
     )
     SELECT
       r.user_key,
       CONVERT(varchar(10), w.window_start, 23) AS window_start,
       COUNT(f.call_key) AS calls
     FROM reps r
     CROSS JOIN windows w
     LEFT JOIN gold.fact_call f
       ON f.tenant_id = @tenantId
       AND f.owner_user_key = r.user_key
       AND f.call_date >= w.window_start
       AND f.call_date <= w.window_end
     GROUP BY r.user_key, w.window_start
     ORDER BY r.user_key, w.window_start`,
    { periodStart, periodDays },
  );
}

async function loadLastPeriodCallsForReps(
  tenantId: string,
  userKeys: string[],
  periodStart: string,
  periodDays: number,
): Promise<{ user_key: string; peer_calls: number }[]> {
  const userKeyValues = userKeys
    .map((k) => `('${k.replace(/'/g, "''")}')`)
    .join(",");
  return queryFabric<{ user_key: string; peer_calls: number }>(
    tenantId,
    `WITH reps AS (
       SELECT user_key FROM (VALUES ${userKeyValues}) AS u(user_key)
     )
     SELECT r.user_key, COUNT(f.call_key) AS peer_calls
     FROM reps r
     LEFT JOIN gold.fact_call f
       ON f.tenant_id = @tenantId
       AND f.owner_user_key = r.user_key
       AND f.call_date >= DATEADD(DAY, -@periodDays, CAST(@periodStart AS date))
       AND f.call_date < CAST(@periodStart AS date)
     GROUP BY r.user_key`,
    { periodStart, periodDays },
  );
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

// ---------------------------------------------------------------------------
// SQL helpers
// ---------------------------------------------------------------------------

async function loadRepHistoricalCalls(
  tenantId: string,
  userKey: string,
  periodStart: string,
  periodDays: number,
  windows: number,
): Promise<{ period_label: string; value: number }[]> {
  // Generate `windows` consecutive equivalent-length periods ending the day
  // before `periodStart`, then count rep's calls in each.
  const valuesList = Array.from({ length: windows }, (_, i) => `(${i})`).join(",");
  const rows = await queryFabric<{ window_start: string; calls: number }>(
    tenantId,
    `WITH anchor AS (
       SELECT DATEADD(DAY, -1, CAST(@periodStart AS date)) AS prev_end
     ),
     windows AS (
       SELECT
         DATEADD(DAY, -((n + 1) * @periodDays - 1), a.prev_end) AS window_start,
         DATEADD(DAY, -(n * @periodDays), a.prev_end) AS window_end
       FROM anchor a
       CROSS JOIN (VALUES ${valuesList}) AS w(n)
     )
     SELECT
       CONVERT(varchar(10), w.window_start, 23) AS window_start,
       COUNT(f.call_key) AS calls
     FROM windows w
     LEFT JOIN gold.fact_call f
       ON f.tenant_id = @tenantId
       AND f.owner_user_key = @userKey
       AND f.call_date >= w.window_start
       AND f.call_date <= w.window_end
     GROUP BY w.window_start
     ORDER BY w.window_start ASC`,
    { userKey, periodStart, periodDays },
  );
  // Filter out windows with zero calls — usually means the rep wasn't active
  // yet (joined company recently). Including them would drag the trend.
  return rows
    .filter((r) => r.calls > 0)
    .map((r) => ({
      period_label: r.window_start,
      value: r.calls,
    }));
}

async function loadPeerMedianCalls(
  tenantId: string,
  userKey: string,
  periodStart: string,
  periodDays: number,
): Promise<number | null> {
  // Peers = other active field reps in the same tenant, same user_type as
  // the target rep. Future refinement: scope to same territory/specialty
  // when those dims land. For now, tenant-wide field reps is the universe.
  const rows = await queryFabric<{ peer_calls: number }>(
    tenantId,
    `WITH target_user AS (
       SELECT user_type FROM gold.dim_user
       WHERE tenant_id = @tenantId AND user_key = @userKey
     ),
     peer_period AS (
       SELECT u.user_key, COUNT(f.call_key) AS peer_calls
       FROM gold.dim_user u
       LEFT JOIN gold.fact_call f
         ON f.tenant_id = @tenantId
         AND f.owner_user_key = u.user_key
         AND f.call_date >= DATEADD(DAY, -@periodDays, CAST(@periodStart AS date))
         AND f.call_date < CAST(@periodStart AS date)
       WHERE u.tenant_id = @tenantId
         AND u.user_key <> @userKey
         AND u.status = 'Active'
         AND u.user_type IN (SELECT user_type FROM target_user)
       GROUP BY u.user_key
       HAVING COUNT(f.call_key) > 0
     )
     SELECT peer_calls FROM peer_period`,
    { userKey, periodStart, periodDays },
  );
  if (rows.length === 0) return null;
  // SQL Server doesn't have a clean MEDIAN aggregate cheap to use; compute
  // in JS over the small peer set.
  const sorted = rows.map((r) => r.peer_calls).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1]! + sorted[mid]!) / 2
    : sorted[mid]!;
}

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

function daysBetween(start: string, end: string): number {
  const a = new Date(start).getTime();
  const b = new Date(end).getTime();
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function avgGrowthRatePct(series: number[]): number {
  if (series.length < 2) return 0;
  const rates: number[] = [];
  for (let i = 1; i < series.length; i++) {
    const prev = series[i - 1]!;
    const curr = series[i]!;
    if (prev === 0) continue;
    rates.push(((curr - prev) / prev) * 100);
  }
  if (rates.length === 0) return 0;
  // Cap at ±50% to keep recommendations sane in volatile windows.
  const raw = rates.reduce((a, b) => a + b, 0) / rates.length;
  return Math.max(-50, Math.min(50, raw));
}

function round(n: number): number {
  // Round to 0 decimals for count metrics. Adjust per metric when sales/
  // dollar metrics land.
  return Math.round(n);
}

// ---------------------------------------------------------------------------
// LLM narration — turns the structured context into a 1-2 sentence rationale
// the admin sees on the form. Reuses the Anthropic client we set up for
// the inbox brief.
// ---------------------------------------------------------------------------

import Anthropic from "@anthropic-ai/sdk";

const NARRATION_MODEL = "claude-sonnet-4-6";

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

export async function narrateRecommendation(
  rec: GoalRecommendation,
  args: {
    entityLabel: string; // e.g. "Keith McCormick"
    metricLabel: string; // e.g. "Q3 calls"
  },
): Promise<string | null> {
  if (rec.context.method === "insufficient_data") return null;
  const anthropic = getClient();
  if (!anthropic) return null;

  const systemPrompt = `You write 1-2 sentence rationales for goal recommendations on a pharma analytics dashboard. \
Be specific — name the numbers. No hedging, no marketing language, no headers, no markdown. \
The reader is a brand lead reviewing dozens of these in a row; brevity matters.`;

  const userPrompt = `Suggested ${args.metricLabel} for ${args.entityLabel}: ${rec.value} ${rec.unit}.\n\nContext:\n${JSON.stringify(rec.context, null, 2)}`;

  try {
    const res = await anthropic.messages.create({
      model: NARRATION_MODEL,
      max_tokens: 150,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const block = res.content.find((b) => b.type === "text");
    return block?.type === "text" ? block.text.trim() : null;
  } catch {
    return null;
  }
}
