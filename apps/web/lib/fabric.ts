// Server-only. Native-query path into Fabric's SQL analytics endpoint.
//
// Foundation for `docs/product/web-display-philosophy.md`: render most
// surfaces natively in React from gold-table queries rather than embedding
// Power BI everywhere. Fabric's SQL endpoint exposes the lakehouse Delta
// tables as a standard SQL Server (TDS) interface; we authenticate using
// the same service principal as the PBI embed flow.

import * as sql from "mssql";

const AAD_TOKEN_ENDPOINT_TEMPLATE =
  "https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token";

// Fabric SQL analytics endpoint reuses Azure SQL's auth surface.
const FABRIC_SQL_SCOPE = "https://database.windows.net/.default";

// AAD access tokens last 60-90 minutes. Refresh ~10min before expiry.
const TOKEN_REFRESH_BUFFER_MS = 10 * 60 * 1000;

type FabricEnv = {
  tenantId: string;       // Entra tenant id — same as POWERBI_TENANT_ID
  clientId: string;       // SP client id — same as POWERBI_CLIENT_ID
  clientSecret: string;   // SP secret — same as POWERBI_CLIENT_SECRET
  server: string;         // Fabric SQL endpoint DNS
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

type CachedToken = { token: string; expiresAt: number };
type CachedPool = { pool: sql.ConnectionPool; tokenExpiresAt: number };

const globalForFabric = globalThis as unknown as {
  fabricToken?: CachedToken;
  fabricPool?: CachedPool;
};

async function getAadToken(env: FabricEnv): Promise<CachedToken> {
  const cached = globalForFabric.fabricToken;
  if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) {
    return cached;
  }
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
  const data = (await res.json()) as { access_token: string; expires_in: number };
  const fresh: CachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  globalForFabric.fabricToken = fresh;
  return fresh;
}

async function getPool(forceRebuild = false): Promise<sql.ConnectionPool> {
  const env = readEnv();
  const token = await getAadToken(env);

  // Reuse pool if connected and token still valid.
  const cached = globalForFabric.fabricPool;
  if (
    !forceRebuild &&
    cached &&
    cached.pool.connected &&
    cached.tokenExpiresAt === token.expiresAt
  ) {
    return cached.pool;
  }

  // Token rotated, pool stale, or forced rebuild — close and rebuild.
  if (cached?.pool.connected) {
    try {
      await cached.pool.close();
    } catch {
      // Closing a half-broken pool can throw; ignore.
    }
  }

  const pool = new sql.ConnectionPool({
    server: env.server,
    database: env.database,
    authentication: {
      type: "azure-active-directory-access-token",
      options: { token: token.token },
    },
    options: {
      encrypt: true,
      trustServerCertificate: false,
    },
  });
  await pool.connect();
  globalForFabric.fabricPool = { pool, tokenExpiresAt: token.expiresAt };
  return pool;
}

// mssql/tedious wraps the auth failure message; match on substrings rather
// than error code, which varies across drivers.
function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("authentication failed") ||
    msg.includes("Login failed") ||
    msg.includes("token") && msg.toLowerCase().includes("expired")
  );
}

// ---------------------------------------------------------------------------
// TENANT-SCOPED QUERY HELPER — the mandatory entry point for gold reads.
//
// Rules:
//   - Every caller MUST pass `tenantId`. It's bound as `@tenantId` and
//     referenced in the SQL's WHERE clause.
//   - Queries without a `tenant_id` filter are caught at code review time.
//   - No raw SQL composition with tenant id in string — always bind.
//
// Example:
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
//   `);
// ---------------------------------------------------------------------------

export async function queryFabric<Row>(
  tenantId: string,
  query: string,
  params?: Record<string, string | number | Date | boolean | null>,
): Promise<Row[]> {
  // mssql binds the auth token at pool-creation time; once the token expires,
  // the pool's reconnect attempts fail with "authentication failed". Catch
  // that one case, force a fresh AAD token + new pool, and retry once.
  try {
    return await runQuery<Row>(await getPool(), tenantId, query, params);
  } catch (err) {
    if (!isAuthError(err)) throw err;
    globalForFabric.fabricToken = undefined;
    const freshPool = await getPool(true);
    return runQuery<Row>(freshPool, tenantId, query, params);
  }
}

async function runQuery<Row>(
  pool: sql.ConnectionPool,
  tenantId: string,
  query: string,
  params: Record<string, string | number | Date | boolean | null> | undefined,
): Promise<Row[]> {
  const request = pool.request();
  request.input("tenantId", tenantId);
  for (const [name, value] of Object.entries(params ?? {})) {
    request.input(name, value);
  }
  const result = await request.query(query);
  return result.recordset as Row[];
}

export { readEnv as __readFabricEnv, getAadToken as __getFabricAadToken };
