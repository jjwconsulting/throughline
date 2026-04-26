// Server-only loaders for the mapping admin page.

import { and, desc, eq, schema } from "@throughline/db";
import { db } from "@/lib/db";
import { queryFabric } from "@/lib/fabric";

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
export async function loadUnmappedAccounts(
  tenantId: string,
): Promise<UnmappedAccount[]> {
  try {
    return await queryFabric<UnmappedAccount>(
      tenantId,
      `SELECT TOP 100
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
export async function loadSavedAccountMappings(
  tenantId: string,
): Promise<SavedMapping[]> {
  return db
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
    .orderBy(desc(schema.mapping.updatedAt));
}
