// CSV download for the goals template, pre-populated with the recommendation
// engine's defaults for a given period. Admin opens in Excel, tweaks the
// 20% they have conviction on, saves, uploads via the form on /admin/goals.
//
// Query params:
//   period      — "YYYY-Q[1-4]" | "YYYY-MM" | "YYYY"  (default: next quarter)
//   metric      — "calls" | "units" (revenue pending)

import { NextRequest, NextResponse } from "next/server";
import { queryFabric } from "@/lib/fabric";
import { getCurrentScope } from "@/lib/scope";
import {
  recommendCallGoalsForReps,
  recommendUnitsGoalsForTerritories,
} from "@/lib/goal-recommendations";
import {
  nextQuarterRange,
  parsePeriodLabel,
  formatPeriodForCsv,
} from "@/app/(app)/admin/goals/period";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { resolution } = await getCurrentScope();
  if (
    !resolution?.ok ||
    (resolution.scope.role !== "admin" && resolution.scope.role !== "bypass")
  ) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const tenantId = resolution.scope.tenantId;

  const { searchParams } = new URL(req.url);
  const periodParam = searchParams.get("period");
  const range = parsePeriodLabel(periodParam) ?? nextQuarterRange(new Date());
  const metric = searchParams.get("metric") ?? "calls";
  if (metric !== "calls" && metric !== "units") {
    return NextResponse.json(
      { error: "Supported metrics: 'calls', 'units'." },
      { status: 400 },
    );
  }

  const periodLabel = formatPeriodForCsv(range.start, range.end);
  const lines: string[] = [];

  if (metric === "units") {
    // Sales goals = territory entity. CSV emits BOTH territory_description
    // (geographic, e.g. "Los Angeles") and territory_name (Veeva code, e.g.
    // "C103") so admins can match by either in Excel. The upload parser
    // accepts either column as the entity-key column. Description is first
    // because it's the recognition path for non-admin readers (per
    // feedback_territory_display).
    const territories = await queryFabric<{
      territory_key: string;
      name: string;
      description: string | null;
      current_rep_name: string | null;
    }>(
      tenantId,
      `SELECT territory_key, name, description, current_rep_name
       FROM gold.dim_territory
       WHERE tenant_id = @tenantId
         AND COALESCE(status, '') IN ('', 'Active', 'active')
       ORDER BY COALESCE(description, name)`,
    );

    const recs = await recommendUnitsGoalsForTerritories(
      tenantId,
      territories.map((t) => t.territory_key),
      range.start,
      range.end,
    );
    const recByKey = new Map(
      recs.map((r) => [r.entity_id, r.recommendation.value]),
    );

    lines.push(
      "territory_description,territory_name,period,goal_units,recommended_units,current_rep",
    );
    for (const t of territories) {
      const recommended = recByKey.get(t.territory_key) ?? 0;
      lines.push(
        `${escapeCsv(t.description ?? "")},${escapeCsv(t.name)},${periodLabel},${recommended},${recommended},${escapeCsv(t.current_rep_name ?? "")}`,
      );
    }
  } else {
    // Calls goals = rep entity (existing behavior).
    const reps = await queryFabric<{
      user_key: string;
      name: string;
      email: string | null;
    }>(
      tenantId,
      `SELECT user_key, name, email
       FROM gold.dim_user
       WHERE tenant_id = @tenantId
         AND status = 'Active'
         AND user_type IN ('Sales', 'Medical')
       ORDER BY name`,
    );

    const recs = await recommendCallGoalsForReps(
      tenantId,
      reps.map((r) => r.user_key),
      range.start,
      range.end,
    );
    const recByKey = new Map(
      recs.map((r) => [r.user_key, r.recommendation.value]),
    );

    lines.push("rep_email,period,goal_calls,recommended_calls");
    for (const rep of reps) {
      const recommended = recByKey.get(rep.user_key) ?? 0;
      if (!rep.email) {
        lines.push(
          `# SKIPPED — no email in Veeva: ${escapeCsv(rep.name)} (user_key=${rep.user_key})`,
        );
        continue;
      }
      lines.push(
        `${escapeCsv(rep.email)},${periodLabel},${recommended},${recommended}`,
      );
    }
  }

  const filename = `throughline-goals-${periodLabel}-${metric}.csv`;
  return new NextResponse(lines.join("\n") + "\n", {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

function escapeCsv(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
