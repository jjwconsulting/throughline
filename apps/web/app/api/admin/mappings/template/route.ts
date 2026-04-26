// CSV download for the account_xref mapping template, pre-populated with
// the current unmapped distributor accounts pulled from gold.fact_sale.
// Admin opens in Excel, fills in veeva_account_id per row, uploads back
// via the form on /admin/mappings.
//
// Unlike goals, mappings have no auto-recommendation — we can't guess the
// distributor↔Veeva pairing. The template's value is delivering the list
// of distributor IDs (with their source name + state) in a spreadsheet
// shape so admins can paste into a vlookup against their existing master
// mapping file from prior consulting work.

import { NextResponse } from "next/server";
import { queryFabric } from "@/lib/fabric";
import { getCurrentScope } from "@/lib/scope";

export async function GET(): Promise<NextResponse> {
  const { resolution } = await getCurrentScope();
  if (
    !resolution?.ok ||
    (resolution.scope.role !== "admin" && resolution.scope.role !== "bypass")
  ) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 });
  }
  const tenantId = resolution.scope.tenantId;

  // Pull every currently-unmapped distributor account. Most-active first
  // so the highest-impact rows are at the top of the spreadsheet.
  let unmapped: {
    distributor_account_id: string;
    distributor_account_name: string | null;
    account_state: string | null;
  }[] = [];
  try {
    unmapped = await queryFabric(
      tenantId,
      `SELECT
         distributor_account_id,
         MAX(distributor_account_name) AS distributor_account_name,
         MAX(account_state) AS account_state
       FROM gold.fact_sale
       WHERE tenant_id = @tenantId
         AND account_key IS NULL
         AND distributor_account_id IS NOT NULL
       GROUP BY distributor_account_id
       ORDER BY COUNT(*) DESC`,
    );
  } catch {
    // gold.fact_sale doesn't exist yet — just return an empty template so
    // admin can still type rows in by hand.
    unmapped = [];
  }

  const lines: string[] = [
    "distributor_account_id,distributor_account_name,veeva_account_id",
    "# Fill in veeva_account_id per row, then upload back. Find Veeva ids on /hcps or /hcos detail pages.",
    "# distributor_account_name is informational only — leave as-is or update to match your spreadsheet.",
    "# Rows with empty veeva_account_id are skipped on upload.",
  ];
  for (const u of unmapped) {
    lines.push(
      [
        escapeCsv(u.distributor_account_id),
        escapeCsv(u.distributor_account_name ?? ""),
        "",
      ].join(","),
    );
  }

  const filename = `throughline-account-mappings-template.csv`;
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
