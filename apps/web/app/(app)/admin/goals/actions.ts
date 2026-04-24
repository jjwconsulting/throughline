"use server";

import { revalidatePath } from "next/cache";
import { schema } from "@throughline/db";
import { db } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import {
  narrateRecommendation,
  type GoalRecommendation,
} from "@/lib/goal-recommendations";

export type SaveGoalsState = {
  error: string | null;
  saved: number;
};

// Form payload shape: per rep, three fields packed into FormData with the
// user_key suffix.
//   value_<user_key>             — the goal value the admin saved
//   recommended_<user_key>       — what we suggested (used to derive source)
//   period_start, period_end, metric, period_type — applied to all rows

export async function saveGoalsAction(
  _prev: SaveGoalsState,
  formData: FormData,
): Promise<SaveGoalsState> {
  const { resolution } = await getCurrentScope();
  if (
    !resolution?.ok ||
    (resolution.scope.role !== "admin" && resolution.scope.role !== "bypass")
  ) {
    return { error: "Not authorized", saved: 0 };
  }

  const periodStart = String(formData.get("period_start") ?? "");
  const periodEnd = String(formData.get("period_end") ?? "");
  const periodType = String(formData.get("period_type") ?? "quarter") as
    | "month"
    | "quarter"
    | "year"
    | "custom";
  const metric = String(formData.get("metric") ?? "calls") as
    | "calls"
    | "units"
    | "revenue"
    | "reach_pct"
    | "frequency";

  if (!periodStart || !periodEnd) {
    return { error: "Period start/end required", saved: 0 };
  }

  // Pull every value_/recommended_ pair off the form. Walking entries() is
  // simpler than knowing keys ahead of time.
  const rows: {
    userKey: string;
    value: number;
    recommended: number | null;
  }[] = [];
  for (const [key, raw] of formData.entries()) {
    if (!key.startsWith("value_")) continue;
    const userKey = key.slice("value_".length);
    const valueStr = String(raw).trim();
    if (valueStr === "") continue; // empty input = skip (don't save anything for this rep)
    const value = Number(valueStr);
    if (!Number.isFinite(value) || value < 0) {
      return {
        error: `Invalid goal value for one of the reps: "${valueStr}"`,
        saved: 0,
      };
    }
    const recommendedRaw = formData.get(`recommended_${userKey}`);
    const recommended =
      recommendedRaw != null && String(recommendedRaw) !== ""
        ? Number(recommendedRaw)
        : null;
    rows.push({ userKey, value, recommended });
  }

  if (rows.length === 0) {
    return { error: "No goal values to save", saved: 0 };
  }

  const tenantId = resolution.scope.tenantId;
  const createdBy = resolution.scope.role; // simple marker; richer audit later

  // Upsert each row. One round trip per row is fine at <200 rows; if the
  // page ever serves thousands of reps, batch into a single VALUES insert.
  for (const r of rows) {
    const isUntouched =
      r.recommended != null && Math.round(r.value) === Math.round(r.recommended);
    await db
      .insert(schema.goal)
      .values({
        tenantId,
        metric,
        entityType: "rep",
        entityId: r.userKey,
        periodType,
        periodStart,
        periodEnd,
        goalValue: String(r.value),
        goalUnit: unitForMetric(metric),
        source: isUntouched ? "recommended" : "manual",
        createdBy,
      })
      .onConflictDoUpdate({
        target: [
          schema.goal.tenantId,
          schema.goal.metric,
          schema.goal.entityType,
          schema.goal.entityId,
          schema.goal.periodStart,
          schema.goal.periodEnd,
        ],
        set: {
          goalValue: String(r.value),
          goalUnit: unitForMetric(metric),
          source: isUntouched ? "recommended" : "manual",
          updatedAt: new Date(),
        },
      });
  }

  revalidatePath("/admin/goals");
  return { error: null, saved: rows.length };
}

// On-demand LLM narration for a single rep's recommendation. Triggered by
// the "?" button on each row. Per the goals product thesis, goals are
// sparsely reviewed — we only burn the LLM call when an admin actually
// wants the rationale, not eagerly for all 91+ rows.

export type NarrateState = {
  narrative: string | null;
  error: string | null;
};

export async function narrateRowAction(
  _prev: NarrateState,
  formData: FormData,
): Promise<NarrateState> {
  const { resolution } = await getCurrentScope();
  if (
    !resolution?.ok ||
    (resolution.scope.role !== "admin" && resolution.scope.role !== "bypass")
  ) {
    return { narrative: null, error: "Not authorized" };
  }

  const entityLabel = String(formData.get("entity_label") ?? "");
  const metricLabel = String(formData.get("metric_label") ?? "");
  const recRaw = String(formData.get("recommendation") ?? "");
  if (!entityLabel || !metricLabel || !recRaw) {
    return { narrative: null, error: "Missing context" };
  }

  let rec: GoalRecommendation;
  try {
    rec = JSON.parse(recRaw) as GoalRecommendation;
  } catch {
    return { narrative: null, error: "Invalid recommendation payload" };
  }

  const narrative = await narrateRecommendation(rec, {
    entityLabel,
    metricLabel,
  });
  if (!narrative) {
    return {
      narrative: null,
      error: process.env.ANTHROPIC_API_KEY
        ? "LLM call failed; try again"
        : "ANTHROPIC_API_KEY not set",
    };
  }
  return { narrative, error: null };
}

function unitForMetric(metric: string): string {
  switch (metric) {
    case "revenue":
      return "usd";
    case "reach_pct":
      return "pct";
    case "calls":
    case "units":
    case "frequency":
    default:
      return "count";
  }
}
