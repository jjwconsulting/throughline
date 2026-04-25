// CSV download for the goals template, pre-populated with the recommendation
// engine's defaults for a given period. Admin opens in Excel, tweaks the
// 20% they have conviction on, saves, uploads via the form on /admin/goals.
//
// Query params:
//   period      — "YYYY-Q[1-4]" | "YYYY-MM" | "YYYY"  (default: next quarter)
//   metric      — "calls"  (others wait on fact_sales)

import { NextRequest, NextResponse } from "next/server";
import { queryFabric } from "@/lib/fabric";
import { getCurrentScope } from "@/lib/scope";
import { recommendCallGoalsForReps } from "@/lib/goal-recommendations";
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
  if (metric !== "calls") {
    return NextResponse.json(
      { error: "Only the 'calls' metric is supported in v1." },
      { status: 400 },
    );
  }

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

  const recommendations = await recommendCallGoalsForReps(
    tenantId,
    reps.map((r) => r.user_key),
    range.start,
    range.end,
  );
  const recByKey = new Map(
    recommendations.map((r) => [r.user_key, r.recommendation.value]),
  );

  const periodLabel = formatPeriodForCsv(range.start, range.end);
  const lines: string[] = [
    "rep_email,period,goal_calls,recommended_calls",
  ];
  for (const rep of reps) {
    const recommended = recByKey.get(rep.user_key) ?? 0;
    // Skip reps without an email — admin can't address them in the upload
    // (we look up user_key by email). Emit a comment line so they know.
    if (!rep.email) {
      lines.push(
        `# SKIPPED — no email in Veeva: ${escapeCsv(rep.name)} (user_key=${rep.user_key})`,
      );
      continue;
    }
    // recommended_calls is informational only (the upload parser ignores it).
    // It's there so the admin can compare what we suggested vs what they set.
    lines.push(
      `${escapeCsv(rep.email)},${periodLabel},${recommended},${recommended}`,
    );
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
