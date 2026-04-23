// Server-only. Native-query path into Fabric's SQL analytics endpoint.
//
// This is the foundation for `docs/product/web-display-philosophy.md`:
// render most surfaces natively in React from gold-table queries, rather
// than embedding Power BI everywhere. Fabric's SQL endpoint exposes the
// lakehouse Delta tables as a standard SQL Server (TDS) interface; we
// authenticate using the same service principal as PBI embed.
//
// SCAFFOLD STATUS: Not yet wired. Next session:
//   1. pnpm add mssql @types/mssql  (workspace at apps/web)
//   2. Verify env vars below exist (FABRIC_SQL_SERVER, reuse POWERBI_* creds)
//   3. Test a trivial query: SELECT COUNT(*) FROM gold.fact_call WHERE tenant_id = ?
//   4. Build the first native dashboard card off this helper

// Uncomment after `pnpm add mssql`:
// import sql from "mssql";

const AAD_TOKEN_ENDPOINT_TEMPLATE =
  "https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token";

// For Fabric SQL analytics endpoint, the AAD scope is the Azure SQL resource.
// (Fabric's TDS endpoint reuses Azure SQL's auth surface.)
// Verify on first use; Microsoft docs have shifted this scope a few times.
const FABRIC_SQL_SCOPE = "https://database.windows.net/.default";

type FabricEnv = {
  tenantId: string;       // Entra tenant id — same as POWERBI_TENANT_ID
  clientId: string;       // SP client id — same as POWERBI_CLIENT_ID
  clientSecret: string;   // SP secret — same as POWERBI_CLIENT_SECRET
  server: string;         // Fabric SQL endpoint DNS
                          // Format: "<workspace-id>-<endpoint-id>.datawarehouse.fabric.microsoft.com"
                          //   OR: "<workspace-guid>.msit.pbidedicated.windows.net"
                          // Get from Fabric lakehouse → SQL analytics endpoint → Connection strings
  database: string;       // Lakehouse name, e.g. "throughline_lakehouse"
};

function readEnv(): FabricEnv {
  const required = [
    "POWERBI_TENANT_ID",
    "POWERBI_CLIENT_ID",
    "POWERBI_CLIENT_SECRET",
    "FABRIC_SQL_SERVER",
    "FABRIC_SQL_DATABASE",
  ] as const;
  for (const name of required) {
    if (!process.env[name]) throw new Error(`${name} is not set`);
  }
  return {
    tenantId: process.env.POWERBI_TENANT_ID!,
    clientId: process.env.POWERBI_CLIENT_ID!,
    clientSecret: process.env.POWERBI_CLIENT_SECRET!,
    server: process.env.FABRIC_SQL_SERVER!,
    database: process.env.FABRIC_SQL_DATABASE!,
  };
}

async function getAadToken(env: FabricEnv): Promise<string> {
  const url = AAD_TOKEN_ENDPOINT_TEMPLATE.replace("{tenantId}", env.tenantId);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.clientId,
      client_secret: env.clientSecret,
      scope: FABRIC_SQL_SCOPE,
    }),
  });
  if (!res.ok) {
    throw new Error(`AAD token error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

// ---------------------------------------------------------------------------
// TENANT-SCOPED QUERY HELPER — the mandatory entry point for gold reads.
//
// Rules:
//   - Every caller MUST pass `tenantId`. It's passed as a named parameter
//     `@tenantId` and referenced in the SQL's WHERE clause.
//   - Queries without a `tenant_id` filter are rejected at build time (if
//     we add a TypeScript template-literal validator) or at review time
//     (bridging mitigations). For now, soft enforcement via code review.
//   - No raw SQL composition with tenant id in string — always use the
//     parameter binding so it can't be bypassed.
//
// Example usage (next session):
//
//   const rows = await queryFabric<{ name: string; calls: number }>(tenantId, `
//     SELECT u.name, COUNT(*) AS calls
//     FROM gold.fact_call f
//     JOIN gold.dim_user u ON u.user_key = f.credit_user_key
//     WHERE f.tenant_id = @tenantId
//       AND u.tenant_id = @tenantId
//       AND u.is_field_user = 1
//     GROUP BY u.name
//     ORDER BY calls DESC
//     LIMIT 10
//   `);
//
// ---------------------------------------------------------------------------

export async function queryFabric<Row>(
  _tenantId: string,
  _query: string,
  _params?: Record<string, string | number | Date | boolean | null>,
): Promise<Row[]> {
  throw new Error(
    "queryFabric is a scaffold. Install `mssql` and implement before using. " +
      "See apps/web/lib/fabric.ts for the sketch.",
  );

  // Implementation sketch — uncomment after pnpm add mssql:
  //
  // const env = readEnv();
  // const token = await getAadToken(env);
  //
  // const pool = await sql.connect({
  //   server: env.server,
  //   database: env.database,
  //   authentication: {
  //     type: "azure-active-directory-access-token",
  //     options: { token },
  //   },
  //   options: {
  //     encrypt: true,
  //     trustServerCertificate: false,
  //   },
  // });
  //
  // const request = pool.request();
  // request.input("tenantId", sql.NVarChar, _tenantId);
  // for (const [name, value] of Object.entries(_params ?? {})) {
  //   // Type inference from JS value; for production harden with explicit types per-param.
  //   request.input(name, value as any);
  // }
  //
  // const result = await request.query(_query);
  // await pool.close();
  // return result.recordset as Row[];
}

// ---------------------------------------------------------------------------
// Connection pooling note
//
// The sketch above creates a fresh pool per call — simple but slow. For
// production, cache the pool globally (same singleton pattern as lib/db.ts)
// so connections are reused across requests. Fabric SQL endpoint has cold-start
// latency on first query (~2-5s); subsequent queries are fast once the pool
// is warm.
// ---------------------------------------------------------------------------

export { readEnv as __readFabricEnv, getAadToken as __getFabricAadToken };
