// Goal lookups for dashboard / detail pages. Goals live canonically in
// Postgres (admin-edited via /admin/goals); analytics live in Fabric. Until
// a goals_sync notebook mirrors goals into gold.fact_goal, the web layer
// queries Postgres separately and joins in JS.
//
// Once gold.fact_goal lands, replace these helpers with native SQL JOINs in
// the interactions queries — same call sites, faster path.

import { and, eq, gte, lte, schema } from "@throughline/db";
import { db } from "@/lib/db";

export type GoalMetric =
  | "calls"
  | "units"
  | "revenue"
  | "reach_pct"
  | "frequency";
export type GoalEntityType =
  | "rep"
  | "territory"
  | "region"
  | "tier"
  | "tenant_wide";

// ---------------------------------------------------------------------------
// Sum of overlapping goal portions for a given range.
//
// For every goal whose period OVERLAPS [rangeStart, rangeEnd]:
//   overlap_days = max(0, min(period_end, rangeEnd) - max(period_start, rangeStart) + 1)
//   contribution = goal_value * overlap_days / period_days
// Returns the sum, or null if no goals overlap.
//
// This is the right semantic for chart display: a 12-week window spanning
// Q1+Q2 picks up BOTH the Q1 goal (prorated to its overlap) and the Q2 goal
// (prorated to its overlap), summed.
//
// `entityFilter`:
//   - { type: "all" }          — sum across all entities of entityType (e.g.
//                                 every rep) for tenant-wide attainment math
//   - { type: "single", id }   — only this entity's goal
//
// Calendar-day proration. Business-day adjustment can be layered on top by
// the caller via a single `gold.dim_date` query, but for v1 calendar is the
// default — easier to reason about and avoids per-page Fabric round trips.
// ---------------------------------------------------------------------------

export type GoalEntityFilter =
  | { type: "all" }
  | { type: "single"; id: string };

export async function loadOverlappingGoalSum(args: {
  tenantId: string;
  metric: GoalMetric;
  entityType: GoalEntityType;
  entityFilter: GoalEntityFilter;
  rangeStart: string;
  rangeEnd: string;
}): Promise<number | null> {
  const baseFilters = [
    eq(schema.goal.tenantId, args.tenantId),
    eq(schema.goal.metric, args.metric),
    eq(schema.goal.entityType, args.entityType),
    // Overlap test: period_start <= rangeEnd AND period_end >= rangeStart.
    // (i.e., the periods are not strictly disjoint.)
    lte(schema.goal.periodStart, args.rangeEnd),
    gte(schema.goal.periodEnd, args.rangeStart),
  ];
  const whereClause =
    args.entityFilter.type === "single"
      ? and(...baseFilters, eq(schema.goal.entityId, args.entityFilter.id))
      : and(...baseFilters);

  const rows = await db
    .select({
      goalValue: schema.goal.goalValue,
      periodStart: schema.goal.periodStart,
      periodEnd: schema.goal.periodEnd,
    })
    .from(schema.goal)
    .where(whereClause);
  if (rows.length === 0) return null;

  const rangeStartMs = new Date(args.rangeStart).getTime();
  const rangeEndMs = new Date(args.rangeEnd).getTime();
  let total = 0;
  for (const row of rows) {
    const periodStartMs = new Date(row.periodStart).getTime();
    const periodEndMs = new Date(row.periodEnd).getTime();
    const overlapStartMs = Math.max(periodStartMs, rangeStartMs);
    const overlapEndMs = Math.min(periodEndMs, rangeEndMs);
    if (overlapEndMs < overlapStartMs) continue; // shouldn't happen given WHERE, but defensive
    const overlapDays = msToDays(overlapEndMs - overlapStartMs) + 1;
    const periodDays = msToDays(periodEndMs - periodStartMs) + 1;
    if (periodDays <= 0) continue;
    total += Number(row.goalValue) * (overlapDays / periodDays);
  }
  return total;
}

function msToDays(ms: number): number {
  return Math.round(ms / (1000 * 60 * 60 * 24));
}

// ---------------------------------------------------------------------------
// Display helper.
// ---------------------------------------------------------------------------

export function attainmentLabel(actual: number, goal: number): {
  pct: number;
  label: string;
} {
  if (goal <= 0) return { pct: 0, label: "—" };
  const pct = (actual / goal) * 100;
  return {
    pct,
    label: `${actual.toLocaleString("en-US")} / ${Math.round(goal).toLocaleString("en-US")} (${pct.toFixed(0)}%)`,
  };
}
