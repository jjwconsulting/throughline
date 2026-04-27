// Goal lookups for dashboard / detail pages.
//
// Postgres is the AUTHORITATIVE source for goals — admins write here via
// /admin/goals (form, CSV upload, recommendation acceptance). Reads happen
// here too so what an admin saves is reflected immediately, no sync lag.
//
// `gold.fact_goal` in Fabric is a downstream batch mirror (built by the
// goals_sync notebook) used only for PBI native measures and future
// SQL-side sales-vs-goal joins. It is NOT read by these helpers.

import { and, eq, gte, inArray, lte, schema } from "@throughline/db";
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

export type GoalEntityFilter =
  | { type: "all" }
  | { type: "single"; id: string }
  | { type: "in"; ids: string[] };

// ---------------------------------------------------------------------------
// Sum of overlapping goal portions for a given range.
//
// For every goal whose period OVERLAPS [rangeStart, rangeEnd]:
//   overlap_days = max(0, min(period_end, rangeEnd) - max(period_start, rangeStart) + 1)
//   contribution = goal_value * overlap_days / period_days
// Returns the sum, or null if no goals overlap.
// ---------------------------------------------------------------------------

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
    lte(schema.goal.periodStart, args.rangeEnd),
    gte(schema.goal.periodEnd, args.rangeStart),
  ];
  // "in" with an empty id list short-circuits — no entities means no goal,
  // not the same as "all" (which would inflate to tenant-wide).
  if (args.entityFilter.type === "in" && args.entityFilter.ids.length === 0) {
    return null;
  }
  const whereClause =
    args.entityFilter.type === "single"
      ? and(...baseFilters, eq(schema.goal.entityId, args.entityFilter.id))
      : args.entityFilter.type === "in"
        ? and(...baseFilters, inArray(schema.goal.entityId, args.entityFilter.ids))
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
    if (overlapEndMs < overlapStartMs) continue;
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
