import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { and, eq, schema } from "@throughline/db";
import { getCurrentScope } from "@/lib/scope";
import { queryFabric } from "@/lib/fabric";
import {
  recommendCallGoalsForReps,
  type GoalRecommendationContext,
} from "@/lib/goal-recommendations";
import GoalsForm, { type RepGoalRow } from "./goals-form";
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

  // Active field reps for this tenant.
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
      <EmptyState
        message="No active field reps in gold.dim_user. Goals need an entity to attach to."
      />
    );
  }

  const userKeys = reps.map((r) => r.user_key);

  const [recommendations, existingGoals] = await Promise.all([
    recommendCallGoalsForReps(tenantId, userKeys, periodStart, periodEnd),
    db
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
          eq(schema.goal.entityType, "rep"),
          eq(schema.goal.periodStart, periodStart),
          eq(schema.goal.periodEnd, periodEnd),
        ),
      ),
  ]);

  const recByKey = new Map(recommendations.map((r) => [r.user_key, r]));
  const existingByKey = new Map(
    existingGoals.map((g) => [g.entityId ?? "", g]),
  );

  const rows: RepGoalRow[] = reps.map((rep) => {
    const rec = recByKey.get(rep.user_key)?.recommendation;
    const existing = existingByKey.get(rep.user_key);
    return {
      user_key: rep.user_key,
      name: rep.name,
      title: rep.title,
      recommended: rec?.value ?? 0,
      method: rec?.context.method ?? "insufficient_data",
      rationale: rationaleFromContext(rec?.context),
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
        periodLabel={formatPeriodLabel(periodStart, periodEnd)}
      />

      <CsvSection periodLabel={formatPeriodForCsv(periodStart, periodEnd)} />
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
): string {
  if (!ctx) return "No data available";
  if (ctx.method === "insufficient_data") {
    return "No historical activity — set manually.";
  }
  if (ctx.method === "peer_average") {
    return `No history for this rep; using peer median (${ctx.peer_median?.toLocaleString("en-US")}).`;
  }
  if (ctx.method === "historical_average") {
    const last = ctx.historical[ctx.historical.length - 1];
    return `Single prior period: ${last?.value.toLocaleString("en-US")} calls. Projecting flat.`;
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
      ? ` Peer median floor: ${ctx.peer_median.toLocaleString("en-US")}.`
      : "";
  return `Recent: ${lastVals}.${growth}${floor}`;
}
