// Server-only — must not be imported from client components.
// Uses the service principal client credentials flow to mint Power BI
// embed tokens for the web app's embedded reports.
//
// Flow:
//   1. Client-credentials POST to Microsoft Entra to get an AAD access token
//      scoped to the Power BI API.
//   2. Use the AAD token to call PBI's /reports/{id} and /GenerateToken
//      endpoints against the target workspace + report.
//
// RLS: not yet wired. For now, embed tokens grant unscoped access to the
// report's data. When the user -> tenant -> territory mapping lands, we'll
// pass an `identities` array to GenerateToken so PBI applies the DefaultUser
// role (see ARCHITECTURE.md §5).

const AAD_SCOPE = "https://analysis.windows.net/powerbi/api/.default";
const PBI_API = "https://api.powerbi.com/v1.0/myorg";

type PbiEnv = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  workspaceId: string;
  reportId: string;
  datasetId: string;
};

function readEnv(): PbiEnv {
  const required = [
    "POWERBI_TENANT_ID",
    "POWERBI_CLIENT_ID",
    "POWERBI_CLIENT_SECRET",
    "POWERBI_WORKSPACE_ID",
    "POWERBI_REPORT_ID",
    "POWERBI_DATASET_ID",
  ] as const;
  for (const name of required) {
    if (!process.env[name]) throw new Error(`${name} is not set`);
  }
  return {
    tenantId: process.env.POWERBI_TENANT_ID!,
    clientId: process.env.POWERBI_CLIENT_ID!,
    clientSecret: process.env.POWERBI_CLIENT_SECRET!,
    workspaceId: process.env.POWERBI_WORKSPACE_ID!,
    reportId: process.env.POWERBI_REPORT_ID!,
    datasetId: process.env.POWERBI_DATASET_ID!,
  };
}

async function getAadToken(env: PbiEnv): Promise<string> {
  const res = await fetch(
    `https://login.microsoftonline.com/${env.tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: env.clientId,
        client_secret: env.clientSecret,
        scope: AAD_SCOPE,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`AAD token error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function fetchReportEmbedUrl(
  env: PbiEnv,
  aadToken: string,
  reportId: string,
): Promise<string> {
  const res = await fetch(
    `${PBI_API}/groups/${env.workspaceId}/reports/${reportId}`,
    { headers: { Authorization: `Bearer ${aadToken}` } },
  );
  if (!res.ok) {
    throw new Error(`Report fetch error: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { embedUrl: string };
  return data.embedUrl;
}

// V2 GenerateToken — required for Direct Lake datasets. Takes explicit
// datasets + reports + target workspace lists and an optional identities
// array for RLS. `xmlaPermissions: "ReadOnly"` on the dataset is what makes
// Direct Lake embedding work.
//
// Identity / RLS design: passes `tenant_id` as `customData` rather than using
// effective identity with USERPRINCIPALNAME(). Direct Lake on lakehouse data
// doesn't support datasource-level SSO in embed-token scenarios, which is
// what `username` + USERPRINCIPALNAME() would require. customData is the
// supported path — arbitrary context string the DAX role reads via
// CUSTOMDATA(). The DAX filter becomes `[tenant_id] = CUSTOMDATA()`.
async function generateEmbedToken(
  env: PbiEnv,
  aadToken: string,
  tenantId: string | null,
  reportId: string,
): Promise<{ token: string; expiration: string }> {
  const identities = tenantId
    ? [
        {
          // username is required by the API but unused by our RLS (we key off
          // customData). Kept as a stable audit marker for token logs.
          username: "throughline-embed",
          roles: ["DefaultUser"],
          datasets: [env.datasetId],
          customData: tenantId,
        },
      ]
    : [];

  const res = await fetch(`${PBI_API}/GenerateToken`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${aadToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      datasets: [{ id: env.datasetId, xmlaPermissions: "ReadOnly" }],
      reports: [{ id: reportId }],
      targetWorkspaces: [{ id: env.workspaceId }],
      identities,
    }),
  });
  if (!res.ok) {
    throw new Error(`GenerateToken error: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as { token: string; expiration: string };
}

export type EmbedConfig = {
  reportId: string;
  embedUrl: string;
  embedToken: string;
  tokenExpiration: string;
};

export async function getReportEmbedConfig(
  tenantId: string | null,
  reportIdOverride?: string,
): Promise<EmbedConfig> {
  const env = readEnv();
  const reportId = reportIdOverride ?? env.reportId;
  const aadToken = await getAadToken(env);
  const [embedUrl, { token, expiration }] = await Promise.all([
    fetchReportEmbedUrl(env, aadToken, reportId),
    generateEmbedToken(env, aadToken, tenantId, reportId),
  ]);
  return {
    reportId,
    embedUrl,
    embedToken: token,
    tokenExpiration: expiration,
  };
}

// The configured reports available for embedding. v1: just the env-configured
// one. Later: a config table / per-tenant report registry, surfaced in the
// reports index.
export type ReportSummary = {
  id: string;
  title: string;
  description: string;
};

export function listReports(): ReportSummary[] {
  const id = process.env.POWERBI_REPORT_ID;
  if (!id) return [];
  return [
    {
      id,
      title: "Operations report",
      description: "The full Power BI canvas — drag fields, build pivots, save views.",
    },
  ];
}
