// Goal lookups for dashboard / detail pages. Goals live canonically in
// Postgres (admin-edited via /admin/goals); analytics live in Fabric. Until
// a goals_sync notebook mirrors goals into gold.fact_goal, the web layer
// queries Postgres separately and joins in JS.
//
// Once gold.fact_goal lands, replace these helpers with native SQL JOINs in
// the interactions queries — same call sites, faster path.

import { and, eq, gte, lte, schema } from "@throughline/db";
import { db } from "@/lib/db";
import { queryFabric } from "@/lib/fabric";

export type GoalForPeriod = {
  value: number;
  unit: string;
  source: string;
  periodStart: string;
  periodEnd: string;
};

// Find the goal whose period CONTAINS the supplied date range. Returns null
// if no goal exists for this entity in any overlapping period.
//
// Pattern: dashboard shows "Calls (last 12 weeks)" — the goal that matters is
// the QUARTERLY goal whose period contains those weeks. We find the goal
// whose period_start ≤ rangeStart AND period_end ≥ rangeEnd.
export async function findGoalContaining(args: {
  tenantId: string;
  metric: "calls" | "units" | "revenue" | "reach_pct" | "frequency";
  entityType: "rep" | "territory" | "region" | "tier" | "tenant_wide";
  entityId: string | null;
  rangeStart: string; // ISO date
  rangeEnd: string;
}): Promise<GoalForPeriod | null> {
  const baseFilters = [
    eq(schema.goal.tenantId, args.tenantId),
    eq(schema.goal.metric, args.metric),
    eq(schema.goal.entityType, args.entityType),
    lte(schema.goal.periodStart, args.rangeStart),
    gte(schema.goal.periodEnd, args.rangeEnd),
  ];
  const whereClause =
    args.entityId == null
      ? and(...baseFilters)
      : and(...baseFilters, eq(schema.goal.entityId, args.entityId));

  const rows = await db
    .select({
      goalValue: schema.goal.goalValue,
      goalUnit: schema.goal.goalUnit,
      source: schema.goal.source,
      periodStart: schema.goal.periodStart,
      periodEnd: schema.goal.periodEnd,
    })
    .from(schema.goal)
    .where(whereClause)
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  return {
    value: Number(row.goalValue),
    unit: row.goalUnit,
    source: row.source,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
  };
}

// Sum of all matching rep-level goals for a tenant in the period — used
// when the dashboard shows tenant-wide metrics and we want "total goal" =
// sum of individual rep goals. Falls back to null if no rep goals exist.
export async function sumRepGoalsForPeriod(args: {
  tenantId: string;
  metric: "calls" | "units" | "revenue" | "reach_pct" | "frequency";
  rangeStart: string;
  rangeEnd: string;
}): Promise<number | null> {
  const rows = await db
    .select({
      goalValue: schema.goal.goalValue,
    })
    .from(schema.goal)
    .where(
      and(
        eq(schema.goal.tenantId, args.tenantId),
        eq(schema.goal.metric, args.metric),
        eq(schema.goal.entityType, "rep"),
        lte(schema.goal.periodStart, args.rangeStart),
        gte(schema.goal.periodEnd, args.rangeEnd),
      ),
    );
  if (rows.length === 0) return null;
  return rows.reduce((acc, r) => acc + Number(r.goalValue), 0);
}

// Time-proration helper. A quarter goal is for the full quarter; if the
// current display window is "last 12 weeks" and the quarter has 13 weeks
// elapsed, the prorated goal target = (12/13) * quarter_goal. Avoids the
// "you're at 30% of quarterly goal but only 20% through the quarter" trap.
//
// Uses CALENDAR days. For the more accurate business-day-aware version
// that excludes weekends + US federal holidays, use prorateGoalByBusinessDays
// (requires a Fabric round trip).
export function prorateGoal(args: {
  goal: GoalForPeriod;
  rangeStart: string;
  rangeEnd: string;
}): number {
  const { goal, rangeStart, rangeEnd } = args;
  const periodMs =
    new Date(goal.periodEnd).getTime() - new Date(goal.periodStart).getTime();
  const rangeMs =
    new Date(rangeEnd).getTime() - new Date(rangeStart).getTime();
  if (periodMs <= 0) return goal.value;
  const fraction = Math.min(1, Math.max(0, rangeMs / periodMs));
  return goal.value * fraction;
}

// Business-day-aware proration. Pulls counts of business days from
// gold.dim_date for both the goal's full period and the display window.
// Use when the goal represents work-day activity (calls, visits) — calendar
// proration overstates the expected target because reps don't work weekends
// or holidays.
//
// Single Fabric round trip (one query returning both counts). Falls back
// silently to calendar proration if `gold.dim_date` doesn't have the
// `is_business_day` column yet (i.e., dim_date hasn't been rebuilt with the
// new schema — typical during the first deploy).
export async function prorateGoalByBusinessDays(args: {
  tenantId: string;
  goal: GoalForPeriod;
  rangeStart: string;
  rangeEnd: string;
}): Promise<number> {
  const { tenantId, goal, rangeStart, rangeEnd } = args;

  try {
    type Row = { period_business_days: number; range_business_days: number };
    const rows = await queryFabric<Row>(
      tenantId,
      `SELECT
         SUM(CASE WHEN d.date BETWEEN @periodStart AND @periodEnd AND d.is_business_day = 1 THEN 1 ELSE 0 END) AS period_business_days,
         SUM(CASE WHEN d.date BETWEEN @rangeStart AND @rangeEnd AND d.is_business_day = 1 THEN 1 ELSE 0 END) AS range_business_days
       FROM gold.dim_date d
       WHERE d.date BETWEEN @periodStart AND @periodEnd
         AND @tenantId IS NOT NULL`,
      {
        periodStart: goal.periodStart,
        periodEnd: goal.periodEnd,
        rangeStart,
        rangeEnd,
      },
    );
    const r = rows[0];
    if (!r || r.period_business_days <= 0) return goal.value;
    const fraction = Math.min(
      1,
      Math.max(0, r.range_business_days / r.period_business_days),
    );
    return goal.value * fraction;
  } catch {
    // dim_date probably hasn't been rebuilt with is_business_day yet.
    // Fall back to the calendar-day proration so the page still works.
    return prorateGoal({ goal, rangeStart, rangeEnd });
  }
}

export function attainmentLabel(actual: number, goal: number): {
  pct: number;
  label: string;
} {
  if (goal <= 0) return { pct: 0, label: "—" };
  const pct = (actual / goal) * 100;
  return {
    pct,
    label: `${actual.toLocaleString("en-US")} / ${goal.toLocaleString("en-US")} (${pct.toFixed(0)}%)`,
  };
}
