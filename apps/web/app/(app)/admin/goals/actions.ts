"use server";

import { revalidatePath } from "next/cache";
import { schema } from "@throughline/db";
import { db } from "@/lib/db";
import { queryFabric } from "@/lib/fabric";
import { getCurrentScope } from "@/lib/scope";
import {
  narrateRecommendation,
  type GoalRecommendation,
} from "@/lib/goal-recommendations";
import { parsePeriodLabel } from "./period";

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
  // Form-driven entity_type — defaults to 'rep' for legacy form posts.
  // Sales (units) goals come in as 'territory' since pharma sets sales
  // goals at the territory level, not the rep level.
  const entityType = String(formData.get("entity_type") ?? "rep") as
    | "rep"
    | "territory";

  if (!periodStart || !periodEnd) {
    return { error: "Period start/end required", saved: 0 };
  }

  // Pull every value_/recommended_ pair off the form. The suffix is the
  // entity id (rep user_key for calls goals, territory_key for sales).
  const rows: {
    entityId: string;
    value: number;
    recommended: number | null;
  }[] = [];
  for (const [key, raw] of formData.entries()) {
    if (!key.startsWith("value_")) continue;
    const entityId = key.slice("value_".length);
    const valueStr = String(raw).trim();
    if (valueStr === "") continue; // empty input = skip (no save for this entity)
    const value = Number(valueStr);
    if (!Number.isFinite(value) || value < 0) {
      return {
        error: `Invalid goal value for one of the entities: "${valueStr}"`,
        saved: 0,
      };
    }
    const recommendedRaw = formData.get(`recommended_${entityId}`);
    const recommended =
      recommendedRaw != null && String(recommendedRaw) !== ""
        ? Number(recommendedRaw)
        : null;
    rows.push({ entityId, value, recommended });
  }

  if (rows.length === 0) {
    return { error: "No goal values to save", saved: 0 };
  }

  const tenantId = resolution.scope.tenantId;
  const createdBy = resolution.scope.role; // simple marker; richer audit later

  // Upsert each row. One round trip per row is fine at <200 rows.
  for (const r of rows) {
    const isUntouched =
      r.recommended != null && Math.round(r.value) === Math.round(r.recommended);
    await db
      .insert(schema.goal)
      .values({
        tenantId,
        metric,
        entityType,
        entityId: r.entityId,
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

// ---------------------------------------------------------------------------
// CSV upload action.
//
// Expected columns:
//   rep_email, period, goal_calls [, recommended_calls (ignored)]
//
// Per-row validation: lookup user_key by email, parse period, coerce value.
// Each row's outcome is reported back; failed rows don't block successful
// ones — admin can fix the file and re-upload (idempotent: upserts on the
// goal unique key).
// ---------------------------------------------------------------------------

export type UploadGoalsState = {
  saved: number;
  rowResults: { line: number; status: "ok" | "error"; message: string }[];
};

export async function uploadGoalsAction(
  _prev: UploadGoalsState,
  formData: FormData,
): Promise<UploadGoalsState> {
  const empty: UploadGoalsState = { saved: 0, rowResults: [] };

  const { resolution } = await getCurrentScope();
  if (
    !resolution?.ok ||
    (resolution.scope.role !== "admin" && resolution.scope.role !== "bypass")
  ) {
    return {
      ...empty,
      rowResults: [{ line: 0, status: "error", message: "Not authorized" }],
    };
  }
  const tenantId = resolution.scope.tenantId;

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return {
      ...empty,
      rowResults: [
        { line: 0, status: "error", message: "No file selected" },
      ],
    };
  }
  if (file.size > 5_000_000) {
    return {
      ...empty,
      rowResults: [
        { line: 0, status: "error", message: "File too large (max 5MB)" },
      ],
    };
  }

  const text = await file.text();
  const rows = parseCsv(text);
  if (rows.length === 0) {
    return {
      ...empty,
      rowResults: [{ line: 0, status: "error", message: "Empty file" }],
    };
  }

  const header = rows[0]!.map((h) => h.toLowerCase().trim());
  // Detect metric from the column name. We accept goal_calls or
  // goal_units in the same uploader so admins don't have to flip a
  // separate metric setting; the file declares its own metric via the
  // column it uses.
  const callsIdx = header.indexOf("goal_calls");
  const unitsIdx = header.indexOf("goal_units");
  let goalIdx = -1;
  let metric: "calls" | "units" = "calls";
  let goalUnit = "count";
  let entityType: "rep" | "territory" = "rep";
  if (callsIdx >= 0) {
    goalIdx = callsIdx;
    metric = "calls";
    goalUnit = "count";
    entityType = "rep";
  } else if (unitsIdx >= 0) {
    goalIdx = unitsIdx;
    metric = "units";
    goalUnit = "units";
    entityType = "territory";
  }
  // Entity column varies by metric. For territory units goals, accept
  // either `territory_description` (geographic, preferred) or
  // `territory_name` (Veeva code) — admins can match by whichever they
  // recognize. Description wins if both are present in the header.
  const entityColIdx =
    entityType === "territory"
      ? header.indexOf("territory_description") >= 0
        ? header.indexOf("territory_description")
        : header.indexOf("territory_name")
      : header.indexOf("rep_email");
  const idx = {
    entity: entityColIdx,
    period: header.indexOf("period"),
    goal: goalIdx,
  };
  if (idx.entity < 0 || idx.period < 0 || idx.goal < 0) {
    const expectedEntity =
      entityType === "territory"
        ? "territory_description (or territory_name)"
        : "rep_email";
    return {
      ...empty,
      rowResults: [
        {
          line: 1,
          status: "error",
          message: `Missing required column(s). Expected: ${expectedEntity}, period, goal_${metric}.`,
        },
      ],
    };
  }

  // Build the entity lookup map: email → user_key for rep goals,
  // lowercase-name OR lowercase-description → territory_key for territory
  // goals. Both forms populate the same map so the row-by-row lookup
  // doesn't care which column the admin used.
  const entityKeyByLookup = new Map<string, string>();
  if (entityType === "territory") {
    const territoryRows = await queryFabric<{
      territory_key: string;
      name: string;
      description: string | null;
    }>(
      tenantId,
      `SELECT territory_key, name, description
       FROM gold.dim_territory
       WHERE tenant_id = @tenantId
         AND COALESCE(status, '') IN ('', 'Active', 'active')`,
    );
    for (const t of territoryRows) {
      entityKeyByLookup.set(t.name.toLowerCase(), t.territory_key);
      if (t.description) {
        entityKeyByLookup.set(t.description.toLowerCase(), t.territory_key);
      }
    }
  } else {
    const userRows = await queryFabric<{
      user_key: string;
      email: string | null;
    }>(
      tenantId,
      `SELECT user_key, email
       FROM gold.dim_user
       WHERE tenant_id = @tenantId
         AND status = 'Active'
         AND user_type IN ('Sales', 'Medical')
         AND email IS NOT NULL`,
    );
    for (const u of userRows) {
      if (u.email) entityKeyByLookup.set(u.email.toLowerCase(), u.user_key);
    }
  }

  const results: UploadGoalsState["rowResults"] = [];
  let saved = 0;
  const createdBy = resolution.scope.role;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    const lineNum = i + 1; // 1-indexed file lines (header is line 1)
    const entityLookup = (row[idx.entity] ?? "").trim().toLowerCase();
    const periodLabel = (row[idx.period] ?? "").trim();
    const goalRaw = (row[idx.goal] ?? "").trim();

    if (!entityLookup && !periodLabel && !goalRaw) continue; // blank row

    const entityKey = entityKeyByLookup.get(entityLookup);
    if (!entityKey) {
      const noun = entityType === "territory" ? "territory" : "rep";
      results.push({
        line: lineNum,
        status: "error",
        message: `No active ${noun} found matching "${entityLookup}"`,
      });
      continue;
    }

    const range = parsePeriodLabel(periodLabel);
    if (!range) {
      results.push({
        line: lineNum,
        status: "error",
        message: `Unrecognized period "${periodLabel}". Use formats like 2026-Q3, 2026-05, or 2026.`,
      });
      continue;
    }

    const goalValue = Number(goalRaw);
    if (!Number.isFinite(goalValue) || goalValue < 0) {
      results.push({
        line: lineNum,
        status: "error",
        message: `Invalid goal_${metric} value "${goalRaw}"`,
      });
      continue;
    }

    try {
      await db
        .insert(schema.goal)
        .values({
          tenantId,
          metric,
          entityType,
          entityId: entityKey,
          periodType: inferPeriodType(periodLabel),
          periodStart: range.start,
          periodEnd: range.end,
          goalValue: String(goalValue),
          goalUnit,
          source: "upload",
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
            goalValue: String(goalValue),
            goalUnit,
            source: "upload",
            updatedAt: new Date(),
          },
        });
      saved += 1;
      results.push({
        line: lineNum,
        status: "ok",
        message: `${entityLookup} ${periodLabel} ${metric} = ${goalValue}`,
      });
    } catch (err) {
      results.push({
        line: lineNum,
        status: "error",
        message: `DB error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  if (saved > 0) revalidatePath("/admin/goals");
  return { saved, rowResults: results };
}

// Tiny CSV parser. Doesn't handle every Excel quirk (escape rules around
// embedded quotes inside quoted fields, etc.) but handles the common cases:
// commas inside quoted fields, BOM, mixed CRLF/LF, leading "# comment"
// lines that we use in the template's "SKIPPED" rows.
function parseCsv(text: string): string[][] {
  const stripBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = stripBom.split(/\r?\n/);
  const rows: string[][] = [];
  for (const raw of lines) {
    if (raw.length === 0) continue;
    if (raw.startsWith("#")) continue; // comment line
    rows.push(splitCsvLine(raw));
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

function inferPeriodType(label: string): "month" | "quarter" | "year" | "custom" {
  if (/Q[1-4]$/i.test(label)) return "quarter";
  if (/^\d{4}-\d{1,2}$/.test(label)) return "month";
  if (/^\d{4}$/.test(label)) return "year";
  return "custom";
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
