// Helpers for listing bronze tables + columns in a tenant's schema.
// Used by /admin/attributes (and potentially future admin surfaces)
// to give admins picker UIs instead of free-form text inputs for
// bronze references.
//
// Per-tenant bronze schema = `bronze_<tenant_slug_with_underscores>`.
// Same convention silver builds use (silver_hcp_build line 187).
//
// Source-system → table-prefix mapping mirrors the bronze ingest
// patterns: veeva_ingest writes `veeva_obj_*`; sftp_ingest writes
// `sftp_<feed_name>`; etc.

import { queryFabric } from "@/lib/fabric";

export type SourceSystem = "veeva" | "sftp" | "email" | "hubspot";

const SOURCE_PREFIXES: Record<SourceSystem, string> = {
  veeva: "veeva_obj_",
  sftp: "sftp_",
  email: "email_",
  hubspot: "hubspot_",
};

function slugToSchema(slug: string): string {
  return `bronze_${slug.replace(/-/g, "_")}`;
}

export type BronzeTable = {
  source_system: SourceSystem;
  table_name: string;
};

export async function listBronzeTablesForTenant(
  tenantId: string,
  tenantSlug: string,
): Promise<BronzeTable[]> {
  const schema = slugToSchema(tenantSlug);
  try {
    const rows = await queryFabric<{ table_name: string }>(
      tenantId,
      `SELECT TABLE_NAME AS table_name
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = '${schema.replace(/'/g, "''")}'
         AND TABLE_TYPE = 'BASE TABLE'
       ORDER BY TABLE_NAME`,
    );
    // Tag each table with its inferred source system. Tables that
    // don't match any known prefix get filtered out — they're not
    // attribute candidates (could be internal staging, _ingested_at
    // tracking tables, etc.).
    const tagged: BronzeTable[] = [];
    for (const r of rows) {
      const table = r.table_name;
      for (const [src, prefix] of Object.entries(SOURCE_PREFIXES) as [
        SourceSystem,
        string,
      ][]) {
        if (table.startsWith(prefix)) {
          tagged.push({ source_system: src, table_name: table });
          break;
        }
      }
    }
    return tagged;
  } catch (err) {
    console.error("listBronzeTablesForTenant failed:", err);
    return [];
  }
}

export type BronzeColumn = {
  column_name: string;
  data_type: string;
};

export async function listBronzeColumnsForTable(
  tenantId: string,
  tenantSlug: string,
  bronzeTable: string,
): Promise<BronzeColumn[]> {
  const schema = slugToSchema(tenantSlug);
  try {
    const rows = await queryFabric<{
      column_name: string;
      data_type: string;
    }>(
      tenantId,
      `SELECT COLUMN_NAME AS column_name, DATA_TYPE AS data_type
       FROM INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = '${schema.replace(/'/g, "''")}'
         AND TABLE_NAME = '${bronzeTable.replace(/'/g, "''")}'
       ORDER BY ORDINAL_POSITION`,
    );
    return rows;
  } catch (err) {
    console.error("listBronzeColumnsForTable failed:", err);
    return [];
  }
}

// Note: `suggestAttributeName` (the pure heuristic for suggesting a
// canonical name from a raw column) lives inline in
// app/(app)/admin/attributes/attribute-form.tsx because that file is a
// client component and importing this module from a client triggers a
// browser-bundle of mssql/tedious (which uses Node-only `dgram`).
