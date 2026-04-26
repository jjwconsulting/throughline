// Server-only. Fabric REST API helper for triggering notebook runs from
// the web app (e.g., the "Run pipeline" button on /admin/mappings).
//
// Distinct from lib/fabric.ts (which uses TDS / mssql to query the SQL
// analytics endpoint). Same service principal, different OAuth scope:
//
//   - SQL analytics endpoint  → https://database.windows.net/.default
//   - Fabric REST API         → https://api.fabric.microsoft.com/.default
//
// The SP needs Workspace Contributor (or higher) role on the target
// Fabric workspace. Same SP we use for the PBI embed should already have
// it; if not, add it in the Fabric workspace → Manage access UI.
//
// Reference: https://learn.microsoft.com/en-us/rest/api/fabric/notebook/items

const AAD_TOKEN_ENDPOINT_TEMPLATE =
  "https://login.microsoftonline.com/{tenantId}/oauth2/v2.0/token";

const FABRIC_API_BASE = "https://api.fabric.microsoft.com/v1";
const FABRIC_API_SCOPE = "https://api.fabric.microsoft.com/.default";

const TOKEN_REFRESH_BUFFER_MS = 10 * 60 * 1000;

type FabricJobsEnv = {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  workspaceId: string;
};

function readEnv(): FabricJobsEnv {
  const required = [
    "POWERBI_TENANT_ID",
    "POWERBI_CLIENT_ID",
    "POWERBI_CLIENT_SECRET",
    "POWERBI_WORKSPACE_ID",
  ] as const;
  for (const name of required) {
    if (!process.env[name]) throw new Error(`${name} is not set`);
  }
  return {
    tenantId: process.env.POWERBI_TENANT_ID!,
    clientId: process.env.POWERBI_CLIENT_ID!,
    clientSecret: process.env.POWERBI_CLIENT_SECRET!,
    workspaceId: process.env.POWERBI_WORKSPACE_ID!,
  };
}

type CachedToken = { token: string; expiresAt: number };
type CachedNotebookId = { id: string; cachedAt: number };
const NOTEBOOK_ID_TTL_MS = 60 * 60 * 1000;

const globalForFabricJobs = globalThis as unknown as {
  fabricJobsToken?: CachedToken;
  // displayName -> notebook id. Workspace items rarely change; an hour
  // TTL avoids repeating the list-notebooks roundtrip on every trigger.
  fabricJobsNotebookIds?: Map<string, CachedNotebookId>;
};

async function getApiToken(env: FabricJobsEnv): Promise<string> {
  const cached = globalForFabricJobs.fabricJobsToken;
  if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_BUFFER_MS) {
    return cached.token;
  }
  const url = AAD_TOKEN_ENDPOINT_TEMPLATE.replace("{tenantId}", env.tenantId);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: env.clientId,
      client_secret: env.clientSecret,
      scope: FABRIC_API_SCOPE,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Fabric API token error: ${res.status} ${await res.text()}`,
    );
  }
  const data = (await res.json()) as {
    access_token: string;
    expires_in: number;
  };
  const fresh: CachedToken = {
    token: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  globalForFabricJobs.fabricJobsToken = fresh;
  return fresh.token;
}

// Resolves a notebook's runtime ID from its display name. Cached for an
// hour. Lets callers reference notebooks by stable display name (which
// matches what's in /data/{name}.Notebook/.platform) rather than tracking
// a runtime id env var per notebook.
export async function getNotebookId(displayName: string): Promise<string> {
  if (!globalForFabricJobs.fabricJobsNotebookIds) {
    globalForFabricJobs.fabricJobsNotebookIds = new Map();
  }
  const cache = globalForFabricJobs.fabricJobsNotebookIds;
  const hit = cache.get(displayName);
  if (hit && Date.now() - hit.cachedAt < NOTEBOOK_ID_TTL_MS) {
    return hit.id;
  }

  const env = readEnv();
  const token = await getApiToken(env);
  const res = await fetch(
    `${FABRIC_API_BASE}/workspaces/${env.workspaceId}/notebooks`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    throw new Error(
      `Fabric list notebooks failed: ${res.status} ${await res.text()}`,
    );
  }
  const data = (await res.json()) as {
    value: { id: string; displayName: string }[];
  };
  // Cache every notebook we got back — the next call for any of them
  // will hit cache.
  const now = Date.now();
  for (const n of data.value) {
    cache.set(n.displayName, { id: n.id, cachedAt: now });
  }
  const found = cache.get(displayName);
  if (!found) {
    throw new Error(
      `Notebook "${displayName}" not found in workspace. Has it been git-synced to Fabric?`,
    );
  }
  return found.id;
}

export type TriggerResult = {
  jobInstanceId: string | null; // Location header suffix; null if API didn't return one
  rawLocation: string | null;
};

// Fires a notebook run. Returns immediately with the job instance id;
// doesn't wait for completion. Caller is responsible for any polling
// (we don't poll today — the UI just shows "started, refresh in N min").
//
// Parameters (optional) override the notebook's "parameters"-tagged cell
// at execution time. Used by mapping_propagate to pass pipeline_run_id,
// tenant_id, triggered_by so the notebook updates the row the web
// action already inserted (instead of double-writing).
export async function triggerNotebookRun(
  displayName: string,
  parameters?: Record<string, string | number | boolean | null>,
): Promise<TriggerResult> {
  const env = readEnv();
  const [token, notebookId] = await Promise.all([
    getApiToken(env),
    getNotebookId(displayName),
  ]);

  const url = `${FABRIC_API_BASE}/workspaces/${env.workspaceId}/items/${notebookId}/jobs/instances?jobType=RunNotebook`;

  // Fabric's executionData.parameters expects each value as
  // { value: string, type: "string" | "int" | "bool" | "float" }.
  // We coerce everything to string for simplicity — notebook-side Python
  // can re-cast as needed.
  let body: string | undefined;
  if (parameters && Object.keys(parameters).length > 0) {
    const fabricParams: Record<string, { value: string; type: string }> = {};
    for (const [k, v] of Object.entries(parameters)) {
      if (v == null) continue;
      fabricParams[k] = { value: String(v), type: "string" };
    }
    body = JSON.stringify({
      executionData: { parameters: fabricParams },
    });
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body,
  });

  if (res.status !== 202) {
    // Fabric returns 202 Accepted on successful trigger. Anything else
    // is an error (auth, missing notebook, capacity throttle, etc.).
    throw new Error(
      `Fabric trigger failed: ${res.status} ${await res.text()}`,
    );
  }

  const location = res.headers.get("location");
  const jobInstanceId = location ? location.split("/").pop() ?? null : null;
  return { jobInstanceId, rawLocation: location };
}
