// Forward-looking insight signals over gold.fact_call. Each loader returns
// rows in the same shape so the UI can render them uniformly.
//
// v1: rule-based, computed on each request (no materialization). When a
// signal becomes a hotspot or we need consistent generated_at timestamps
// across surfaces, promote to gold.signal table built by a notebook.
//
// All loaders accept the standard RLS Scope so signals respect per-user
// visibility — a rep sees signals about THEIR HCPs, a manager sees their
// team's, an admin sees the whole tenant.

import { and, eq, gte, lte, schema } from "@throughline/db";
import { db } from "@/lib/db";
import { queryFabric } from "@/lib/fabric";
import { type Scope } from "@/lib/interactions";
import type { UserScope } from "@/lib/scope";

export type SignalSeverity = "info" | "warning" | "alert";

export type Signal = {
  // Stable identifier for the signal type (used as React key + future routing).
  type: string;
  severity: SignalSeverity;
  // Headline rendered in the panel; should be self-contained.
  title: string;
  // Optional secondary line — what to do, or context.
  detail?: string;
  // Linked entity for drill-through; clicking the signal goes here.
  href: string;
  // Sortable rank within a panel (higher = more urgent / more recent activity).
  rank: number;
};

// ---------------------------------------------------------------------------
// HCP inactivity: HCPs the user has engaged before but hasn't contacted
// in the last 60 days. Sorted by most-recently-active first (fresh lapse
// matters more than ancient lapse).
// ---------------------------------------------------------------------------

const INACTIVITY_THRESHOLD_DAYS = 60;
const MAX_SIGNALS = 10;

type InactiveHcpRow = {
  hcp_key: string;
  name: string;
  specialty: string | null;
  tier: string | null;
  last_call_date: string;
  days_since: number;
};

export async function loadHcpInactivitySignals(
  tenantId: string,
  scope: Scope,
): Promise<Signal[]> {
  const rows = await queryFabric<InactiveHcpRow>(
    tenantId,
    `WITH last_contact AS (
       SELECT
         f.hcp_key,
         MAX(f.call_date) AS last_call_date
       FROM gold.fact_call f
       WHERE f.tenant_id = @tenantId
         AND f.hcp_key IS NOT NULL
         ${scope.clauses.join(" ")}
       GROUP BY f.hcp_key
     )
     SELECT TOP ${MAX_SIGNALS}
       h.hcp_key,
       h.name,
       h.specialty_primary AS specialty,
       h.tier,
       CONVERT(varchar(10), lc.last_call_date, 23) AS last_call_date,
       DATEDIFF(DAY, lc.last_call_date, CAST(GETDATE() AS date)) AS days_since
     FROM last_contact lc
     JOIN gold.dim_hcp h ON h.hcp_key = lc.hcp_key AND h.tenant_id = @tenantId
     WHERE lc.last_call_date < DATEADD(DAY, -${INACTIVITY_THRESHOLD_DAYS}, CAST(GETDATE() AS date))
     ORDER BY lc.last_call_date DESC`,
    scope.params,
  );

  return rows.map((r) => ({
    type: "hcp_inactive_60d",
    severity: severityFromTier(r.tier, r.days_since),
    title: `${r.name}${r.specialty ? ` (${r.specialty})` : ""}`,
    detail: `${r.days_since} days since last contact${r.tier ? ` · Tier ${r.tier}` : ""}`,
    href: `/hcps/${encodeURIComponent(r.hcp_key)}`,
    rank: -r.days_since, // less negative = sorts higher (most recent lapse first)
  }));
}

// Tier 1 inactive is more urgent than Tier 4 inactive. Without tier info we
// fall back to recency: longer-lapsed = more urgent (warning vs info).
function severityFromTier(
  tier: string | null,
  daysSince: number,
): SignalSeverity {
  if (tier === "1" || tier?.toLowerCase() === "tier 1") return "alert";
  if (daysSince > 120) return "warning";
  return "info";
}

// ---------------------------------------------------------------------------
// Activity drop: reps whose last-7-day call count is meaningfully lower than
// their prior-7-day count. "Meaningful" = drop >= 25% AND prior baseline >= 5
// calls (avoids noise from low-volume reps).
// ---------------------------------------------------------------------------

const ACTIVITY_DROP_PCT = 0.25;
const ACTIVITY_MIN_BASELINE = 5;

type ActivityDropRow = {
  user_key: string;
  name: string;
  recent_calls: number;
  prior_calls: number;
};

export async function loadActivityDropSignals(
  tenantId: string,
  scope: Scope,
): Promise<Signal[]> {
  // Rolling 7-day comparison (apples-to-apples in window length):
  //   recent = (today-6) through today  (7 days inclusive)
  //   prior  = (today-13) through (today-7)  (7 days inclusive, immediately before recent)
  // This avoids partial-week bias that calendar-week math would introduce.
  const rows = await queryFabric<ActivityDropRow>(
    tenantId,
    `WITH bounds AS (
       SELECT
         CAST(GETDATE() AS date) AS today,
         DATEADD(DAY, -6, CAST(GETDATE() AS date)) AS recent_start,
         DATEADD(DAY, -7, CAST(GETDATE() AS date)) AS prior_end,
         DATEADD(DAY, -13, CAST(GETDATE() AS date)) AS prior_start
     ),
     rep_counts AS (
       SELECT
         u.user_key,
         u.name,
         SUM(CASE WHEN f.call_date >= b.recent_start AND f.call_date <= b.today THEN 1 ELSE 0 END) AS recent_calls,
         SUM(CASE WHEN f.call_date >= b.prior_start AND f.call_date <= b.prior_end THEN 1 ELSE 0 END) AS prior_calls
       FROM gold.fact_call f
       CROSS JOIN bounds b
       JOIN gold.dim_user u ON u.user_key = f.owner_user_key AND u.tenant_id = @tenantId
       WHERE f.tenant_id = @tenantId
         AND f.call_date >= b.prior_start
         AND f.call_date <= b.today
         AND u.user_type IN ('Sales', 'Medical')
         ${scope.clauses.join(" ")}
       GROUP BY u.user_key, u.name
     )
     SELECT user_key, name, recent_calls, prior_calls
     FROM rep_counts
     WHERE prior_calls >= ${ACTIVITY_MIN_BASELINE}
       AND CAST(recent_calls AS float) / NULLIF(prior_calls, 0) <= ${1 - ACTIVITY_DROP_PCT}
     ORDER BY (prior_calls - recent_calls) DESC`,
    scope.params,
  );

  return rows.slice(0, MAX_SIGNALS).map((r) => {
    const dropPct = Math.round(((r.prior_calls - r.recent_calls) / r.prior_calls) * 100);
    return {
      type: "activity_drop_7d",
      severity: dropPct >= 50 ? "warning" : "info",
      title: `${r.name} — ${dropPct}% drop in calls (7d)`,
      detail: `${r.recent_calls} in the last 7 days vs ${r.prior_calls} in the 7 days before`,
      href: `/reps/${encodeURIComponent(r.user_key)}`,
      rank: r.prior_calls - r.recent_calls,
    };
  });
}

// ---------------------------------------------------------------------------
// Over-targeting: HCPs called more than N times in the last 30 days. Often
// a sign of diminishing returns or that a rep is leaning on a comfortable
// account at the expense of broader coverage.
// ---------------------------------------------------------------------------

const OVER_TARGETING_THRESHOLD = 6;
const OVER_TARGETING_WINDOW_DAYS = 30;

type OverTargetedRow = {
  hcp_key: string;
  name: string;
  specialty: string | null;
  call_count: number;
};

export async function loadOverTargetingSignals(
  tenantId: string,
  scope: Scope,
): Promise<Signal[]> {
  const rows = await queryFabric<OverTargetedRow>(
    tenantId,
    `SELECT TOP ${MAX_SIGNALS}
       h.hcp_key,
       h.name,
       h.specialty_primary AS specialty,
       COUNT(*) AS call_count
     FROM gold.fact_call f
     JOIN gold.dim_hcp h ON h.hcp_key = f.hcp_key AND h.tenant_id = @tenantId
     WHERE f.tenant_id = @tenantId
       AND f.call_date >= DATEADD(DAY, -${OVER_TARGETING_WINDOW_DAYS}, CAST(GETDATE() AS date))
       AND f.call_date <= CAST(GETDATE() AS date)
       ${scope.clauses.join(" ")}
     GROUP BY h.hcp_key, h.name, h.specialty_primary
     HAVING COUNT(*) > ${OVER_TARGETING_THRESHOLD}
     ORDER BY COUNT(*) DESC`,
    scope.params,
  );

  return rows.map((r) => ({
    type: "hcp_over_targeted",
    severity: r.call_count >= 12 ? "warning" : "info",
    title: `${r.name}${r.specialty ? ` (${r.specialty})` : ""}`,
    detail: `${r.call_count} calls in the last ${OVER_TARGETING_WINDOW_DAYS} days — possible diminishing returns`,
    href: `/hcps/${encodeURIComponent(r.hcp_key)}`,
    rank: r.call_count,
  }));
}

// ---------------------------------------------------------------------------
// Goal pace: reps whose actual calls so far in the current goal period are
// meaningfully behind the linear pro-rated pace. Surfaces a "Rep behind
// pace, needs X/day to attain" item with severity based on the gap size.
//
// Calendar-day proration (matches loadOverlappingGoalSum to keep the math
// consistent across surfaces). Business-day refinement is a future polish.
// ---------------------------------------------------------------------------

const PACE_WARN_THRESHOLD = 0.85; // actual < 0.85 * expected pace
const PACE_ALERT_THRESHOLD = 0.7; // actual < 0.7  * expected pace

// Pulls goals from Postgres (authoritative, fresh) then actuals from Fabric
// (calls data only lives there), and joins in JS. Reading goals from Postgres
// means there's no sync lag between admin save and signal display — the
// downstream gold.fact_goal mirror is for PBI / SQL analytics only.
export async function loadGoalPaceSignals(
  tenantId: string,
  userScope: UserScope,
  sqlScope: Scope, // for the Fabric actuals query (RLS)
): Promise<Signal[]> {
  const today = new Date().toISOString().slice(0, 10);
  const todayMs = new Date(today).getTime();

  // 1. Goals — current-period rep call goals from Postgres (authoritative).
  const goals = await db
    .select({
      entityId: schema.goal.entityId,
      goalValue: schema.goal.goalValue,
      periodStart: schema.goal.periodStart,
      periodEnd: schema.goal.periodEnd,
    })
    .from(schema.goal)
    .where(
      and(
        eq(schema.goal.tenantId, tenantId),
        eq(schema.goal.metric, "calls"),
        eq(schema.goal.entityType, "rep"),
        lte(schema.goal.periodStart, today),
        gte(schema.goal.periodEnd, today),
      ),
    );
  const visibleGoals = goals
    .filter((g): g is typeof g & { entityId: string } => g.entityId != null)
    .filter((g) => isUserKeyVisible(userScope, g.entityId));
  if (visibleGoals.length === 0) return [];

  // 2. Actuals — one Fabric query joining a VALUES list of (user_key,
  //    period_start) so each rep's call count is filtered to their own
  //    goal period. RLS applies via sqlScope clauses on fact_call.
  const valuesList = visibleGoals
    .map((g) => `('${g.entityId.replace(/'/g, "''")}','${g.periodStart}')`)
    .join(",");
  const actuals = await queryFabric<{
    user_key: string;
    rep_name: string;
    actual_calls: number;
  }>(
    tenantId,
    `WITH targets AS (
       SELECT user_key, CAST(period_start AS date) AS period_start
       FROM (VALUES ${valuesList}) AS t(user_key, period_start)
     )
     SELECT t.user_key, u.name AS rep_name, COUNT(f.call_key) AS actual_calls
     FROM targets t
     JOIN gold.dim_user u ON u.user_key = t.user_key AND u.tenant_id = @tenantId
     LEFT JOIN gold.fact_call f
       ON f.tenant_id = @tenantId
       AND f.owner_user_key = t.user_key
       AND f.call_date >= t.period_start
       AND f.call_date <= CAST(GETDATE() AS date)
       ${sqlScope.clauses.join(" ")}
     GROUP BY t.user_key, u.name`,
    sqlScope.params,
  );
  const actualByKey = new Map(actuals.map((a) => [a.user_key, a]));

  // 3. Per goal: pace math + signal severity.
  const signals: Signal[] = [];
  for (const goal of visibleGoals) {
    const actual = actualByKey.get(goal.entityId);
    if (!actual) continue;

    const periodStartMs = new Date(goal.periodStart).getTime();
    const periodEndMs = new Date(goal.periodEnd).getTime();
    const totalDays = msToDays(periodEndMs - periodStartMs) + 1;
    const elapsedDays = Math.min(
      totalDays,
      msToDays(todayMs - periodStartMs) + 1,
    );
    if (totalDays <= 0 || elapsedDays <= 0) continue;

    const goalValue = Number(goal.goalValue);
    const expectedPace = goalValue * (elapsedDays / totalDays);
    const ratio = expectedPace > 0 ? actual.actual_calls / expectedPace : 1;
    if (ratio >= PACE_WARN_THRESHOLD) continue;

    const severity: SignalSeverity =
      ratio < PACE_ALERT_THRESHOLD ? "alert" : "warning";
    const remaining = Math.max(0, goalValue - actual.actual_calls);
    const daysLeft = Math.max(1, totalDays - elapsedDays);
    const neededPerDay = Math.ceil(remaining / daysLeft);
    const pctOfPace = Math.round(ratio * 100);
    const periodLabel = formatPeriodShort(goal.periodStart, goal.periodEnd);

    signals.push({
      type: "goal_pace_behind",
      severity,
      title: `${actual.rep_name} — ${actual.actual_calls.toLocaleString("en-US")} of ${goalValue.toLocaleString("en-US")} (${pctOfPace}% of pace)`,
      detail: `${periodLabel} · needs ${neededPerDay}/day for ${daysLeft} more day${daysLeft === 1 ? "" : "s"} to attain`,
      href: `/reps/${encodeURIComponent(goal.entityId)}`,
      rank: -ratio * 100,
    });
  }

  signals.sort((a, b) => {
    const sevOrder: Record<SignalSeverity, number> = {
      alert: 0,
      warning: 1,
      info: 2,
    };
    const s = sevOrder[a.severity] - sevOrder[b.severity];
    if (s !== 0) return s;
    return a.rank - b.rank;
  });

  return signals.slice(0, MAX_SIGNALS);
}

// ---------------------------------------------------------------------------
// Sales goal pace: TERRITORIES whose actual net units so far in the current
// goal period are meaningfully behind linear pro-rated pace. Mirrors
// loadGoalPaceSignals (calls), but the goal entity is territory not rep —
// matches the Phase B convention that sales goals live with the territory
// (stable unit of market potential) and reps inherit credit via current_rep.
//
// Visibility: a rep sees pace warnings only for territories where they're
// the current primary rep; managers see their team's territories; admins
// see all (including territories with no current rep — those are admin-
// actionable, "assign a rep before the period closes").
// ---------------------------------------------------------------------------

export async function loadSalesGoalPaceSignals(
  tenantId: string,
  userScope: UserScope,
): Promise<Signal[]> {
  const today = new Date().toISOString().slice(0, 10);
  const todayMs = new Date(today).getTime();

  // 1. Goals — current-period TERRITORY units goals from Postgres.
  const goals = await db
    .select({
      entityId: schema.goal.entityId,
      goalValue: schema.goal.goalValue,
      periodStart: schema.goal.periodStart,
      periodEnd: schema.goal.periodEnd,
    })
    .from(schema.goal)
    .where(
      and(
        eq(schema.goal.tenantId, tenantId),
        eq(schema.goal.metric, "units"),
        eq(schema.goal.entityType, "territory"),
        lte(schema.goal.periodStart, today),
        gte(schema.goal.periodEnd, today),
      ),
    );
  const goalsWithEntity = goals.filter(
    (g): g is typeof g & { entityId: string } => g.entityId != null,
  );
  if (goalsWithEntity.length === 0) return [];

  // 2. Resolve territory display info + current rep so we can both
  //    visibility-filter and label the signal nicely.
  const territoryKeyList = goalsWithEntity
    .map((g) => `'${g.entityId.replace(/'/g, "''")}'`)
    .join(",");
  const territories = await queryFabric<{
    territory_key: string;
    name: string;
    description: string | null;
    current_rep_user_key: string | null;
    current_rep_name: string | null;
  }>(
    tenantId,
    `SELECT territory_key, name, description, current_rep_user_key, current_rep_name
     FROM gold.dim_territory
     WHERE tenant_id = @tenantId
       AND territory_key IN (${territoryKeyList})`,
  );
  const tByKey = new Map(territories.map((t) => [t.territory_key, t]));

  // 3. Visibility filter. Territories with no current rep are admin-only.
  const visibleGoals = goalsWithEntity.filter((g) => {
    const t = tByKey.get(g.entityId);
    if (!t) return false; // Goal points at a territory not in dim_territory.
    if (t.current_rep_user_key == null) {
      return userScope.role === "admin" || userScope.role === "bypass";
    }
    return isUserKeyVisible(userScope, t.current_rep_user_key);
  });
  if (visibleGoals.length === 0) return [];

  // 4. Actuals — sum of signed_units per territory for the goal period.
  //    No fact_sale RLS clause needed: the goal-list filter above already
  //    enforces visibility (current-state attribution means territory_key
  //    aggregates and rep_user_key aggregates are equivalent).
  const valuesList = visibleGoals
    .map((g) => `('${g.entityId.replace(/'/g, "''")}','${g.periodStart}')`)
    .join(",");
  const actuals = await queryFabric<{
    territory_key: string;
    actual_units: number;
  }>(
    tenantId,
    `WITH targets AS (
       SELECT territory_key, CAST(period_start AS date) AS period_start
       FROM (VALUES ${valuesList}) AS t(territory_key, period_start)
     )
     SELECT t.territory_key, COALESCE(SUM(f.signed_units), 0) AS actual_units
     FROM targets t
     LEFT JOIN gold.fact_sale f
       ON f.tenant_id = @tenantId
       AND f.territory_key = t.territory_key
       AND f.transaction_date >= t.period_start
       AND f.transaction_date <= CAST(GETDATE() AS date)
     GROUP BY t.territory_key`,
  );
  const actualByKey = new Map(actuals.map((a) => [a.territory_key, a]));

  // 5. Per goal: pace math + signal severity. Same thresholds as the
  //    calls pace signal so the inbox stays visually consistent.
  const signals: Signal[] = [];
  for (const goal of visibleGoals) {
    const t = tByKey.get(goal.entityId);
    const actual = actualByKey.get(goal.entityId);
    if (!t || !actual) continue;

    const periodStartMs = new Date(goal.periodStart).getTime();
    const periodEndMs = new Date(goal.periodEnd).getTime();
    const totalDays = msToDays(periodEndMs - periodStartMs) + 1;
    const elapsedDays = Math.min(
      totalDays,
      msToDays(todayMs - periodStartMs) + 1,
    );
    if (totalDays <= 0 || elapsedDays <= 0) continue;

    const goalValue = Number(goal.goalValue);
    const expectedPace = goalValue * (elapsedDays / totalDays);
    const actualUnits = Number(actual.actual_units);
    const ratio = expectedPace > 0 ? actualUnits / expectedPace : 1;
    if (ratio >= PACE_WARN_THRESHOLD) continue;

    const severity: SignalSeverity =
      ratio < PACE_ALERT_THRESHOLD ? "alert" : "warning";
    const remaining = Math.max(0, goalValue - actualUnits);
    const daysLeft = Math.max(1, totalDays - elapsedDays);
    const neededPerDay = Math.ceil(remaining / daysLeft);
    const pctOfPace = Math.round(ratio * 100);
    const periodLabel = formatPeriodShort(goal.periodStart, goal.periodEnd);

    // Display: prefer description (geographic, e.g. "Los Angeles") over the
    // code (e.g. "C103") per feedback_territory_display. Code rendered in
    // parens when both exist so admins can still cross-reference Veeva.
    const territoryLabel = t.description ?? t.name;
    const codeChunk = t.description ? ` (${t.name})` : "";
    const repChunk = t.current_rep_name
      ? ` · ${t.current_rep_name}`
      : " · no current rep";

    signals.push({
      type: "sales_goal_pace_behind",
      severity,
      title: `${territoryLabel}${codeChunk} — ${Math.round(actualUnits).toLocaleString("en-US")} of ${Math.round(goalValue).toLocaleString("en-US")} units (${pctOfPace}% of pace)`,
      detail: `${periodLabel}${repChunk} · needs ${neededPerDay.toLocaleString("en-US")}/day for ${daysLeft} more day${daysLeft === 1 ? "" : "s"} to attain`,
      // Drill to the current rep's page (where the same attainment + pace
      // chart now render). If no rep, send admins to the goals admin so
      // they can see the period + reassign. Reps can't reach this branch.
      href: t.current_rep_user_key
        ? `/reps/${encodeURIComponent(t.current_rep_user_key)}`
        : "/admin/goals?metric=units",
      rank: -ratio * 100,
    });
  }

  signals.sort((a, b) => {
    const sevOrder: Record<SignalSeverity, number> = {
      alert: 0,
      warning: 1,
      info: 2,
    };
    const s = sevOrder[a.severity] - sevOrder[b.severity];
    if (s !== 0) return s;
    return a.rank - b.rank;
  });

  return signals.slice(0, MAX_SIGNALS);
}

function isUserKeyVisible(scope: UserScope, userKey: string): boolean {
  switch (scope.role) {
    case "admin":
    case "bypass":
      return true;
    case "rep":
      return scope.userKey === userKey;
    case "manager":
      return scope.userKeys.includes(userKey);
  }
}

function msToDays(ms: number): number {
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

function formatPeriodShort(periodStart: string, periodEnd: string): string {
  const s = new Date(periodStart);
  const e = new Date(periodEnd);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  // Year only when end ≠ start year (rare for goal periods)
  if (s.getUTCFullYear() === e.getUTCFullYear()) {
    return `${fmt(s)}–${fmt(e)} ${e.getUTCFullYear()}`;
  }
  return `${fmt(s)} ${s.getUTCFullYear()} – ${fmt(e)} ${e.getUTCFullYear()}`;
}

// ---------------------------------------------------------------------------
// Unmapped distributor accounts: high-$ distributor IDs flowing into
// fact_sale that don't have a Veeva account_xref entry yet. Admin-only —
// reps don't manage mappings. Postgres-authoritative (excludes any
// distributor already mapped in Postgres, regardless of whether the
// Fabric pipeline has refreshed gold.fact_sale.account_key).
// ---------------------------------------------------------------------------

const UNMAPPED_RECENT_DAYS = 90;
const UNMAPPED_DOLLAR_THRESHOLD = 1_000;
const UNMAPPED_WARNING_DOLLAR_THRESHOLD = 10_000;

type UnmappedDistributorRow = {
  distributor_account_id: string;
  distributor_account_name: string | null;
  account_state: string | null;
  net_gross_dollars: number;
  rows: number;
  last_seen: string;
};

export async function loadUnmappedAccountSignals(
  tenantId: string,
  userScope: UserScope,
): Promise<Signal[]> {
  // Admin/bypass only — reps don't manage account_xref mappings.
  if (userScope.role !== "admin" && userScope.role !== "bypass") return [];

  let rows: UnmappedDistributorRow[] = [];
  try {
    rows = await queryFabric<UnmappedDistributorRow>(
      tenantId,
      `SELECT TOP 100
         distributor_account_id,
         MAX(distributor_account_name) AS distributor_account_name,
         MAX(account_state) AS account_state,
         ROUND(SUM(signed_gross_dollars), 0) AS net_gross_dollars,
         COUNT(*) AS rows,
         CONVERT(varchar(10), MAX(transaction_date), 23) AS last_seen
       FROM gold.fact_sale
       WHERE tenant_id = @tenantId
         AND account_key IS NULL
         AND distributor_account_id IS NOT NULL
         AND transaction_date >= DATEADD(DAY, -${UNMAPPED_RECENT_DAYS}, CAST(GETDATE() AS date))
       GROUP BY distributor_account_id
       HAVING ABS(SUM(signed_gross_dollars)) >= ${UNMAPPED_DOLLAR_THRESHOLD}
       ORDER BY ABS(SUM(signed_gross_dollars)) DESC`,
    );
  } catch {
    return [];
  }
  if (rows.length === 0) return [];

  // Postgres-authoritative filter: a distributor with a saved mapping
  // shouldn't appear here even if Fabric hasn't refreshed yet. Same
  // pattern as /admin/mappings page.
  const savedKeys = await db
    .select({ sourceKey: schema.mapping.sourceKey })
    .from(schema.mapping)
    .where(
      and(
        eq(schema.mapping.tenantId, tenantId),
        eq(schema.mapping.kind, "account_xref"),
      ),
    );
  const savedSet = new Set(savedKeys.map((s) => s.sourceKey));

  return rows
    .filter((r) => !savedSet.has(r.distributor_account_id))
    .slice(0, MAX_SIGNALS)
    .map((r) => {
      const dollars = Math.abs(r.net_gross_dollars);
      const dollarStr =
        dollars >= 1_000_000
          ? `$${(dollars / 1_000_000).toFixed(1)}M`
          : dollars >= 1_000
            ? `$${(dollars / 1_000).toFixed(0)}K`
            : `$${Math.round(dollars)}`;
      const name = r.distributor_account_name ?? r.distributor_account_id;
      const stateChunk = r.account_state ? ` · ${r.account_state}` : "";
      return {
        type: "unmapped_distributor",
        severity: dollars >= UNMAPPED_WARNING_DOLLAR_THRESHOLD ? "warning" : "info",
        title: `${name} — ${dollarStr} unmapped`,
        detail: `${r.rows} sales row${r.rows === 1 ? "" : "s"}${stateChunk} · last seen ${r.last_seen}`,
        href: "/admin/mappings",
        rank: dollars,
      } satisfies Signal;
    });
}

// ---------------------------------------------------------------------------
// Combined loader for the inbox page.
// ---------------------------------------------------------------------------

export type SignalGroup = {
  key: string;
  title: string;
  subtitle: string;
  signals: Signal[];
};

export async function loadAllSignals(
  tenantId: string,
  userScope: UserScope,
  sqlScope: Scope,
): Promise<SignalGroup[]> {
  const [inactive, drop, overTargeted, pace, salesPace, unmapped] =
    await Promise.all([
      loadHcpInactivitySignals(tenantId, sqlScope),
      loadActivityDropSignals(tenantId, sqlScope),
      loadOverTargetingSignals(tenantId, sqlScope),
      loadGoalPaceSignals(tenantId, userScope, sqlScope),
      loadSalesGoalPaceSignals(tenantId, userScope),
      loadUnmappedAccountSignals(tenantId, userScope),
    ]);

  const isAdminLike =
    userScope.role === "admin" || userScope.role === "bypass";

  const groups: SignalGroup[] = [];

  // Admin-only: surface the mapping work-to-do at the TOP since it
  // gates accurate sales attribution downstream. Skip the group entirely
  // for non-admins (no point showing reps an empty "unmapped accounts"
  // panel they can't act on).
  if (isAdminLike) {
    groups.push({
      key: "unmapped_accounts",
      title: "Unmapped distributor accounts",
      subtitle: `Sales-active distributors over the last ${UNMAPPED_RECENT_DAYS} days with no Veeva mapping yet (≥$${(UNMAPPED_DOLLAR_THRESHOLD / 1_000).toFixed(0)}K). Map these so the dashboard's HCO breakdowns attribute correctly.`,
      signals: unmapped,
    });
  }

  groups.push(
    {
      key: "goal_pace_behind",
      title: "Behind on goal pace",
      subtitle: `Reps below ${Math.round(PACE_WARN_THRESHOLD * 100)}% of pro-rated pace on their current call goal`,
      signals: pace,
    },
    {
      key: "sales_goal_pace_behind",
      title: "Behind on sales pace",
      subtitle: `Territories below ${Math.round(PACE_WARN_THRESHOLD * 100)}% of pro-rated pace on their current units goal`,
      signals: salesPace,
    },
    {
      key: "hcp_inactive_60d",
      title: "HCPs to re-engage",
      subtitle: `Engaged previously, no contact in the last ${INACTIVITY_THRESHOLD_DAYS} days`,
      signals: inactive,
    },
    {
      key: "activity_drop_7d",
      title: "Activity drop",
      subtitle: `Reps whose call count fell ≥${Math.round(ACTIVITY_DROP_PCT * 100)}% over the last 7 days vs the 7 days before`,
      signals: drop,
    },
    {
      key: "hcp_over_targeted",
      title: "Possibly over-targeted",
      subtitle: `HCPs called more than ${OVER_TARGETING_THRESHOLD} times in the last ${OVER_TARGETING_WINDOW_DAYS} days`,
      signals: overTargeted,
    },
  );
  return groups;
}
