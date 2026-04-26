// Server-only loaders for the mapping admin page.

import { and, count, desc, eq, schema } from "@throughline/db";
import { db } from "@/lib/db";
import { queryFabric } from "@/lib/fabric";

// Saved mappings load cap. Above this, the SavedMappingsList shows a
// "capped at X of Y" message so admins know they're not seeing the full
// set. 500 keeps the client component tree light while comfortably
// covering current tenant volume; revisit when a tenant exceeds it.
export const SAVED_MAPPINGS_LOAD_CAP = 500;

export type UnmappedAccount = {
  distributor_account_id: string;
  distributor_account_name: string | null;
  account_city: string | null;
  account_state: string | null;
  account_postal_code: string | null;
  rows: number;
  signed_units: number | null;
  signed_gross_dollars: number | null;
  last_seen: string | null;
};

// Pulls unmapped distributor accounts from gold.fact_sale, ranked by row
// count desc (most-active sources surface first; admins fix high-impact
// accounts first). Falls back to empty if gold.fact_sale doesn't exist
// yet — the dashboard tab still renders.
//
// Over-fetches a buffer (TOP 500 vs the eventual 100 displayed) because
// the page filters this list against the Postgres `mapping` table so
// admins see immediate effect from saving — without a buffer, mappings
// that resolve the top-N rows would leave the visible list near-empty
// even when more truly-unmapped IDs exist further down the row-count
// tail. account_key still comes from the Fabric account_xref join (sync-
// lagged), but the Postgres exclusion happens at render time.
export async function loadUnmappedAccounts(
  tenantId: string,
): Promise<UnmappedAccount[]> {
  try {
    return await queryFabric<UnmappedAccount>(
      tenantId,
      `SELECT TOP 500
         distributor_account_id,
         MAX(distributor_account_name) AS distributor_account_name,
         MAX(account_city) AS account_city,
         MAX(account_state) AS account_state,
         MAX(account_postal_code) AS account_postal_code,
         COUNT(*) AS rows,
         ROUND(SUM(signed_units), 0) AS signed_units,
         ROUND(SUM(signed_gross_dollars), 0) AS signed_gross_dollars,
         CONVERT(varchar(10), MAX(transaction_date), 23) AS last_seen
       FROM gold.fact_sale
       WHERE tenant_id = @tenantId
         AND account_key IS NULL
         AND distributor_account_id IS NOT NULL
       GROUP BY distributor_account_id
       ORDER BY rows DESC`,
    );
  } catch {
    return [];
  }
}

export type SavedMapping = {
  id: string;
  sourceKey: string;
  targetValue: string;
  notes: string | null;
  updatedBy: string;
  updatedAt: Date;
};

// Account_xref mappings saved in Postgres (the canonical store). These
// will be reflected in gold.fact_sale once: config_sync mirrors to Fabric
// + silver_account_xref_build runs + gold_fact_sale_build runs.
//
// Returns up to SAVED_MAPPINGS_LOAD_CAP rows + a separate total count
// so the SavedMappingsList component can show "capped at N of M" when
// truncated. Total count is a cheap separate query (covered by the
// (tenant, kind) index pattern).
export async function loadSavedAccountMappings(
  tenantId: string,
): Promise<{ rows: SavedMapping[]; total: number }> {
  const [rows, totalRows] = await Promise.all([
    db
      .select({
        id: schema.mapping.id,
        sourceKey: schema.mapping.sourceKey,
        targetValue: schema.mapping.targetValue,
        notes: schema.mapping.notes,
        updatedBy: schema.mapping.updatedBy,
        updatedAt: schema.mapping.updatedAt,
      })
      .from(schema.mapping)
      .where(
        and(
          eq(schema.mapping.tenantId, tenantId),
          eq(schema.mapping.kind, "account_xref"),
        ),
      )
      .orderBy(desc(schema.mapping.updatedAt))
      .limit(SAVED_MAPPINGS_LOAD_CAP),
    db
      .select({ n: count() })
      .from(schema.mapping)
      .where(
        and(
          eq(schema.mapping.tenantId, tenantId),
          eq(schema.mapping.kind, "account_xref"),
        ),
      ),
  ]);
  return { rows, total: Number(totalRows[0]?.n ?? 0) };
}

// Most-recent pipeline_run row for a tenant + the mapping_propagate kind,
// used to render the "Last run X minutes ago" line on /admin/mappings.
// status begins 'queued' on insert, flips to 'running' once the Fabric
// trigger API confirms (202 Accepted), and stays there until/unless we
// add status polling or the orchestrator notebook writes back.
export type LastPipelineRun = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  triggeredBy: string;
  createdAt: Date;
  finishedAt: Date | null;
  message: string | null;
};

export async function loadLastMappingPipelineRun(
  tenantId: string,
): Promise<LastPipelineRun | null> {
  const rows = await db
    .select({
      id: schema.pipelineRun.id,
      status: schema.pipelineRun.status,
      triggeredBy: schema.pipelineRun.triggeredBy,
      createdAt: schema.pipelineRun.createdAt,
      finishedAt: schema.pipelineRun.finishedAt,
      message: schema.pipelineRun.message,
    })
    .from(schema.pipelineRun)
    .where(
      and(
        eq(schema.pipelineRun.tenantId, tenantId),
        eq(schema.pipelineRun.kind, "mapping_propagate"),
      ),
    )
    .orderBy(desc(schema.pipelineRun.createdAt))
    .limit(1);
  return rows[0] ?? null;
}
