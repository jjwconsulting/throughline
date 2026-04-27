import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { and, eq, schema } from "@throughline/db";
import { getCurrentScope } from "@/lib/scope";
import { queryFabric } from "@/lib/fabric";
import {
  recommendCallGoalsForReps,
  recommendUnitsGoalsForTerritories,
  type GoalRecommendationContext,
} from "@/lib/goal-recommendations";
import GoalsForm, { type EntityGoalRow } from "./goals-form";
import PeriodPicker from "./period-picker";
import CsvSection from "./csv-section";
import {
  formatPeriodLabel,
  formatPeriodForCsv,
  nextRangeForPeriodType,
  nextQuarterRange,
  type PeriodType,
} from "./period";

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AdminGoalsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const { resolution } = await getCurrentScope();
  if (
    !resolution?.ok ||
    (resolution.scope.role !== "admin" && resolution.scope.role !== "bypass")
  ) {
    notFound();
  }
  const tenantId = resolution.scope.tenantId;

  const sp = await searchParams;
  const periodType = (pickStr(sp.period_type) ?? "quarter") as PeriodType;
  // Defaults derive from period_type so switching to Month gives a month
  // window, not a quarter window. Custom falls back to next-quarter.
  const defaults =
    nextRangeForPeriodType(periodType, new Date()) ??
    nextQuarterRange(new Date());
  const periodStart = pickStr(sp.period_start) ?? defaults.start;
  const periodEnd = pickStr(sp.period_end) ?? defaults.end;
  const metric = (pickStr(sp.metric) ?? "calls") as
    | "calls"
    | "units"
    | "revenue"
    | "reach_pct"
    | "frequency";

  // Metric → entity_type mapping. Calls goals are per-rep (rep activity
  // is rep-specific). Sales (units) goals are per-territory (territories
  // are stable units of market potential; reps come/go but the goal
  // stays with the territory). See project memory:
  // project_pipeline_architecture.
  const entityType: "rep" | "territory" =
    metric === "units" ? "territory" : "rep";

  let entities: { entity_id: string; name: string; subtitle: string | null }[];
  let recommendations: { entity_id: string; recommendation: import("@/lib/goal-recommendations").GoalRecommendation }[];

  if (entityType === "territory") {
    // Pull dim_territory with each territory's current rep as subtitle
    // context. Territories without a current Sales rep still show; their
    // goal stays with the territory and credit kicks in once a rep is
    // assigned in Veeva.
    const territories = await queryFabric<{
      territory_key: string;
      name: string;
      current_rep_name: string | null;
      team_role: string | null;
    }>(
      tenantId,
      `SELECT territory_key, name, current_rep_name, team_role
       FROM gold.dim_territory
       WHERE tenant_id = @tenantId
         AND COALESCE(status, '') IN ('', 'Active', 'active')
       ORDER BY name`,
    );

    if (territories.length === 0) {
      return (
        <EmptyState message="No active territories in gold.dim_territory. Sales goals need an entity to attach to." />
      );
    }

    entities = territories.map((t) => ({
      entity_id: t.territory_key,
      name: t.name,
      // Subtitle shows team role + currently assigned rep so the admin
      // sees who's covering the territory at goal-set time.
      subtitle: [
        t.team_role,
        t.current_rep_name ? `Rep: ${t.current_rep_name}` : "No rep",
      ]
        .filter(Boolean)
        .join(" · "),
    }));

    const territoryRecs = await recommendUnitsGoalsForTerritories(
      tenantId,
      territories.map((t) => t.territory_key),
      periodStart,
      periodEnd,
    );
    recommendations = territoryRecs;
  } else {
    // Calls goals — per rep (existing behavior).
    const reps = await queryFabric<{
      user_key: string;
      name: string;
      title: string | null;
    }>(
      tenantId,
      `SELECT user_key, name, title
       FROM gold.dim_user
       WHERE tenant_id = @tenantId
         AND status = 'Active'
         AND user_type IN ('Sales', 'Medical')
       ORDER BY name`,
    );

    if (reps.length === 0) {
      return (
        <EmptyState message="No active field reps in gold.dim_user. Goals need an entity to attach to." />
      );
    }

    entities = reps.map((r) => ({
      entity_id: r.user_key,
      name: r.name,
      subtitle: r.title,
    }));

    const repRecs = await recommendCallGoalsForReps(
      tenantId,
      reps.map((r) => r.user_key),
      periodStart,
      periodEnd,
    );
    // Normalize to entity_id-keyed shape.
    recommendations = repRecs.map((r) => ({
      entity_id: r.user_key,
      recommendation: r.recommendation,
    }));
  }

  // Existing saved goals for this metric × entity_type × period (Postgres
  // is authoritative for admin-edited state).
  const existingGoals = await db
    .select({
      entityId: schema.goal.entityId,
      goalValue: schema.goal.goalValue,
      source: schema.goal.source,
    })
    .from(schema.goal)
    .where(
      and(
        eq(schema.goal.tenantId, tenantId),
        eq(schema.goal.metric, metric),
        eq(schema.goal.entityType, entityType),
        eq(schema.goal.periodStart, periodStart),
        eq(schema.goal.periodEnd, periodEnd),
      ),
    );

  const recByKey = new Map(recommendations.map((r) => [r.entity_id, r]));
  const existingByKey = new Map(
    existingGoals.map((g) => [g.entityId ?? "", g]),
  );

  const rows: EntityGoalRow[] = entities.map((entity) => {
    const rec = recByKey.get(entity.entity_id)?.recommendation;
    const existing = existingByKey.get(entity.entity_id);
    return {
      entity_id: entity.entity_id,
      name: entity.name,
      subtitle: entity.subtitle,
      recommended: rec?.value ?? 0,
      method: rec?.context.method ?? "insufficient_data",
      rationale: rationaleFromContext(rec?.context, metric),
      recommendation_json: rec ? JSON.stringify(rec) : "",
      existing_value: existing ? Number(existing.goalValue) : null,
      existing_source: existing?.source ?? null,
    };
  });

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/users"
          className="text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          ← Users
        </Link>
        <h1 className="font-display text-3xl mt-2">Goals</h1>
        <p className="text-[var(--color-ink-muted)]">
          Recommendations are pre-filled from historical actuals + peer benchmarks.
          Adjust the handful you have conviction about, then save.
        </p>
      </div>

      <PeriodPicker
        initialPeriodStart={periodStart}
        initialPeriodEnd={periodEnd}
        initialPeriodType={periodType}
        initialMetric={metric}
      />

      <GoalsForm
        rows={rows}
        periodStart={periodStart}
        periodEnd={periodEnd}
        periodType={periodType}
        metric={metric}
        entityType={entityType}
        entityNoun={entityType === "territory" ? "Territory" : "Rep"}
        periodLabel={formatPeriodLabel(periodStart, periodEnd)}
      />

      <CsvSection
        periodLabel={formatPeriodForCsv(periodStart, periodEnd)}
        metric={metric === "units" ? "units" : "calls"}
      />
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl">Goals</h1>
      </div>
      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-12 text-center text-sm text-[var(--color-ink-muted)]">
        {message}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small helpers — page-local
// ---------------------------------------------------------------------------

function pickStr(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

function rationaleFromContext(
  ctx: GoalRecommendationContext | undefined,
  metric: string,
): string {
  if (!ctx) return "No data available";
  // Metric-aware noun for the narration so units goals don't say "calls".
  const noun =
    metric === "units" ? "units" : metric === "revenue" ? "$" : "calls";
  if (ctx.method === "insufficient_data") {
    return "No historical activity — set manually.";
  }
  if (ctx.method === "peer_average") {
    return `No history for this rep; using peer median (${ctx.peer_median?.toLocaleString("en-US")} ${noun}).`;
  }
  if (ctx.method === "historical_average") {
    const last = ctx.historical[ctx.historical.length - 1];
    return `Single prior period: ${last?.value.toLocaleString("en-US")} ${noun}. Projecting flat.`;
  }
  // trend_with_peer_floor
  const lastVals = ctx.historical
    .slice(-3)
    .map((h) => h.value.toLocaleString("en-US"))
    .join(", ");
  const growth =
    ctx.growth_rate_pct != null
      ? ` Growth ${ctx.growth_rate_pct >= 0 ? "+" : ""}${ctx.growth_rate_pct.toFixed(0)}%/period.`
      : "";
  const floor =
    ctx.peer_median != null
      ? ` Peer median floor: ${ctx.peer_median.toLocaleString("en-US")} ${noun}.`
      : "";
  return `Recent ${noun}: ${lastVals}.${growth}${floor}`;
}
