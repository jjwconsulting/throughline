// Team rollup: per-rep summary card data for the manager/admin team
// summary panel on /dashboard. One row per rep on the user's team
// with calls, calls attainment, net units, units attainment, last call.
//
// Reps don't get this surface (they see their own data on
// /reps/[user_key]); the loader returns [] for rep-role.
//
// Goal math is pro-rated overlapping portions (same shape as
// loadOverlappingGoalSum + loadGoalPaceSignals) — for each goal whose
// period overlaps the dashboard window, contribute
// `goal_value * overlap_days / period_days` to the rep's total.

import { and, eq, gte, inArray, lte, schema } from "@throughline/db";
import { db } from "@/lib/db";
import { queryFabric } from "@/lib/fabric";
import type { UserScope } from "@/lib/scope";
import {
  rangeDates,
  type DashboardFilters,
} from "@/app/(app)/dashboard/filters";

export type TeamRollupRow = {
  user_key: string;
  name: string;
  title: string | null;
  user_type: string | null;
  calls_period: number;
  calls_goal: number | null;
  calls_attainment_pct: number | null;
  net_units_period: number;
  units_goal: number | null;
  units_attainment_pct: number | null;
  // ISO date of MAX(call_date) ever for this rep (not just within
  // the period — matches the "Last call" semantic on /dashboard KPIs).
  last_call_date: string | null;
};

export async function loadTeamRollup(
  tenantId: string,
  userScope: UserScope,
  filters: DashboardFilters,
): Promise<TeamRollupRow[]> {
  // Reps see themselves on /reps/[user_key] — no team rollup for them.
  if (userScope.role === "rep") return [];

  const dates = rangeDates(filters.range);
  if (!dates) return []; // attainment math needs a window

  // Determine team userKeys.
  let teamKeys: string[];
  if (userScope.role === "manager") {
    teamKeys = userScope.userKeys;
  } else {
    // admin / bypass — all active Sales/Medical reps in tenant.
    const allReps = await queryFabric<{ user_key: string }>(
      tenantId,
      `SELECT user_key
       FROM gold.dim_user
       WHERE tenant_id = @tenantId
         AND status = 'Active'
         AND user_type IN ('Sales', 'Medical')`,
    );
    teamKeys = allReps.map((r) => r.user_key);
  }
  if (teamKeys.length === 0) return [];

  // Inline IN list — userKeys come from our own DB / dim_user, trusted
  // but escape single quotes defensively. Same pattern as scopeToSql.
  const sanitized = teamKeys
    .map((k) => `'${k.replace(/'/g, "''")}'`)
    .join(",");
  const periodParams = {
    teamPeriodStart: dates.start,
    teamPeriodEnd: dates.end,
  };

  // Four parallel Fabric queries — meta, calls activity, sales
  // activity, and the rep→territory map (needed to compute units goal
  // sums). Each scoped to teamKeys via inline IN.
  const [repMeta, callsRows, salesRows, territoryRows] = await Promise.all([
    queryFabric<{
      user_key: string;
      name: string;
      title: string | null;
      user_type: string | null;
    }>(
      tenantId,
      `SELECT user_key, name, title, user_type
       FROM gold.dim_user
       WHERE tenant_id = @tenantId
         AND user_key IN (${sanitized})`,
    ),
    queryFabric<{
      user_key: string;
      calls_period: number;
      last_call_date: string | null;
    }>(
      tenantId,
      `SELECT
         f.owner_user_key AS user_key,
         COALESCE(SUM(CASE WHEN f.call_date >= @teamPeriodStart AND f.call_date <= @teamPeriodEnd THEN 1 ELSE 0 END), 0) AS calls_period,
         CONVERT(varchar(10), MAX(f.call_date), 23) AS last_call_date
       FROM gold.fact_call f
       WHERE f.tenant_id = @tenantId
         AND f.owner_user_key IN (${sanitized})
       GROUP BY f.owner_user_key`,
      periodParams,
    ),
    queryFabric<{
      user_key: string;
      net_units_period: number;
    }>(
      tenantId,
      `SELECT
         f.rep_user_key AS user_key,
         ROUND(SUM(CASE WHEN f.transaction_date >= @teamPeriodStart AND f.transaction_date <= @teamPeriodEnd THEN f.signed_units ELSE 0 END), 0) AS net_units_period
       FROM gold.fact_sale f
       WHERE f.tenant_id = @tenantId
         AND f.rep_user_key IN (${sanitized})
       GROUP BY f.rep_user_key`,
      periodParams,
    ),
    queryFabric<{
      user_key: string;
      territory_key: string;
    }>(
      tenantId,
      `SELECT
         current_rep_user_key AS user_key,
         territory_key
       FROM gold.dim_territory
       WHERE tenant_id = @tenantId
         AND current_rep_user_key IN (${sanitized})
         AND COALESCE(status, '') IN ('', 'Active', 'active')`,
    ),
  ]);

  const territoriesByRep = new Map<string, string[]>();
  for (const t of territoryRows) {
    const list = territoriesByRep.get(t.user_key) ?? [];
    list.push(t.territory_key);
    territoriesByRep.set(t.user_key, list);
  }
  const allTerritoryKeys = territoryRows.map((t) => t.territory_key);

  // Two batched Postgres goal queries — call goals (rep entity) and
  // unit goals (territory entity). Single round-trip each.
  const [callGoals, unitGoals] = await Promise.all([
    db
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
          inArray(schema.goal.entityId, teamKeys),
          lte(schema.goal.periodStart, dates.end),
          gte(schema.goal.periodEnd, dates.start),
        ),
      ),
    allTerritoryKeys.length > 0
      ? db
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
              inArray(schema.goal.entityId, allTerritoryKeys),
              lte(schema.goal.periodStart, dates.end),
              gte(schema.goal.periodEnd, dates.start),
            ),
          )
      : Promise.resolve(
          [] as {
            entityId: string | null;
            goalValue: string;
            periodStart: string;
            periodEnd: string;
          }[],
        ),
  ]);

  // Pro-rate each goal to the dashboard window, then accumulate.
  const callsGoalByRep = new Map<string, number>();
  for (const g of callGoals) {
    if (!g.entityId) continue;
    const portion = overlapPortion(g, dates);
    callsGoalByRep.set(
      g.entityId,
      (callsGoalByRep.get(g.entityId) ?? 0) + portion,
    );
  }

  // For unit goals: pro-rate per territory first, then sum per rep
  // using territoriesByRep. Avoids N×M iteration.
  const unitsGoalByTerritory = new Map<string, number>();
  for (const g of unitGoals) {
    if (!g.entityId) continue;
    const portion = overlapPortion(g, dates);
    unitsGoalByTerritory.set(
      g.entityId,
      (unitsGoalByTerritory.get(g.entityId) ?? 0) + portion,
    );
  }
  const unitsGoalByRep = new Map<string, number>();
  for (const [userKey, territoryKeys] of territoriesByRep.entries()) {
    let sum = 0;
    for (const tKey of territoryKeys) {
      sum += unitsGoalByTerritory.get(tKey) ?? 0;
    }
    if (sum > 0) unitsGoalByRep.set(userKey, sum);
  }

  // Assemble rows from repMeta as the source of truth so reps with
  // zero activity still appear (visible "no calls / no sales" rows
  // are the actionable signal).
  const callsByRep = new Map(callsRows.map((r) => [r.user_key, r]));
  const salesByRep = new Map(salesRows.map((r) => [r.user_key, r]));

  const rows: TeamRollupRow[] = repMeta.map((meta) => {
    const calls = callsByRep.get(meta.user_key);
    const sales = salesByRep.get(meta.user_key);
    const callsGoal = callsGoalByRep.get(meta.user_key) ?? null;
    const unitsGoal = unitsGoalByRep.get(meta.user_key) ?? null;

    const callsPeriod = Number(calls?.calls_period ?? 0);
    const unitsPeriod = Number(sales?.net_units_period ?? 0);

    return {
      user_key: meta.user_key,
      name: meta.name,
      title: meta.title,
      user_type: meta.user_type,
      calls_period: callsPeriod,
      calls_goal: callsGoal,
      calls_attainment_pct:
        callsGoal && callsGoal > 0 ? (callsPeriod / callsGoal) * 100 : null,
      net_units_period: unitsPeriod,
      units_goal: unitsGoal,
      units_attainment_pct:
        unitsGoal && unitsGoal > 0 ? (unitsPeriod / unitsGoal) * 100 : null,
      last_call_date: calls?.last_call_date ?? null,
    };
  });

  // Sort by sales attainment ASC (worst first — manager's "who needs
  // help" ordering). Reps with no units goal sink to the bottom (they
  // don't have a measurable signal); within "no goal" group, alphabetical.
  rows.sort((a, b) => {
    const aa = a.units_attainment_pct;
    const bb = b.units_attainment_pct;
    if (aa == null && bb == null) return a.name.localeCompare(b.name);
    if (aa == null) return 1;
    if (bb == null) return -1;
    return aa - bb;
  });
  return rows;
}

function overlapPortion(
  goal: { goalValue: string; periodStart: string; periodEnd: string },
  range: { start: string; end: string },
): number {
  const periodStartMs = new Date(goal.periodStart).getTime();
  const periodEndMs = new Date(goal.periodEnd).getTime();
  const rangeStartMs = new Date(range.start).getTime();
  const rangeEndMs = new Date(range.end).getTime();
  const overlapStartMs = Math.max(periodStartMs, rangeStartMs);
  const overlapEndMs = Math.min(periodEndMs, rangeEndMs);
  if (overlapEndMs < overlapStartMs) return 0;
  const msToDays = (ms: number) => Math.round(ms / (1000 * 60 * 60 * 24));
  const overlapDays = msToDays(overlapEndMs - overlapStartMs) + 1;
  const periodDays = msToDays(periodEndMs - periodStartMs) + 1;
  if (periodDays <= 0) return 0;
  return Number(goal.goalValue) * (overlapDays / periodDays);
}
