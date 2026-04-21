# Architecture

Decisions that everything else depends on. Read this before writing code.

## Goals

- **Multi-tenant from day one.** Every schema, query, and UI path assumes N tenants sharing infrastructure.
- **Keep ops simple.** One Fabric workspace, one Lakehouse, one semantic model per product tier. No per-tenant forks.
- **Keep cost low until there's revenue.** F2 dev capacity with pause/resume discipline; scale up only when a paying customer lands.
- **Don't repeat Fennec's single-client shortcuts** (hardcoded IDs, disabled incrementals, no tests, no CI/CD, manual override tables never created by code).

## Non-goals

- Per-tenant custom code branches. If a customer needs bespoke logic, they get config toggles or user-editable mappings, not a fork.
- Supporting non-Fabric data platforms. We're opinionated: Fabric + Power BI.
- Building custom charts in the web app. Power BI embed is the display primitive.

---

## 1. Tenancy model

**Silver and gold: shared schema with `tenant_id` column on every table. One Power BI semantic model, RLS filters by user (tenant_id flows through `dim_user`).**

**Bronze: per-tenant schemas (`bronze_<tenant_slug>`).** Source shapes differ per client — a shared bronze table is the wrong abstraction at the landing layer.

### Why bronze is per-tenant

Veeva Vault (and, to a lesser extent, SFTP/email drops) have client-specific shapes:
- Custom fields (`*__c`) differ per client
- Custom objects differ
- Picklist values differ (territory codes, channel names, specialties)
- Even standard-object field availability depends on per-client Vault config

A single `bronze.veeva_account` table across tenants means either dropping all custom fields (losing data) or coercing into a JSON blob (unqueryable). Neither is acceptable. Per-tenant bronze lets each client's landing schema match their source exactly.

Silver and gold stay shared because the **business entities** (HCP, HCO, call, territory, demand) are the same across clients — only the source field names differ. Silver-build notebooks normalize per-tenant bronze into shared silver via a config-driven field map (see §4).

### Why not the other options for silver/gold

| Model | Verdict | Why |
|---|---|---|
| Schema-per-tenant at silver/gold | Rejected | N×tables explodes; PBI semantic model can't reference tenant-variable schemas cleanly. Operational nightmare at 20+ tenants. |
| Lakehouse-per-tenant in shared workspace | Rejected | Can't share transforms. PBI model would need to switch data sources per tenant (effectively N models). Defeats "single workspace". |
| Workspace-per-tenant | Rejected | User confirmed: "super cumbersome." |
| **Shared silver/gold + `tenant_id` column** | **Chosen** | One set of analytics tables, one semantic model, one deployment. RLS is well-proven for this exact pattern. |

### Leak-risk mitigations (mandatory)

- Every Spark read/write in notebooks goes through a thin helper (`tenant_frame(spark, table, tenant_id)`) that auto-filters and auto-stamps `tenant_id`. Direct reads without the helper fail code review.
- PBI RLS is the second line of defense — even if a query leaks rows, users only see their tenant's via `USERPRINCIPALNAME()` → `dim_user` → `tenant_id` filter chain.
- A scheduled tenant-isolation check queries: *any row in any fact where the joined dimension's `tenant_id` ≠ the fact's `tenant_id`?* If it returns >0 rows, page on-call.

---

## 2. Lakehouse & schemas

One Lakehouse: `throughline_lakehouse`. Schemas:

```
bronze_<tenant_slug>/  Per-tenant raw landing. Shape matches the source (Veeva Vault,
                       SFTP feeds, email drops). One schema per tenant.
silver/                Shared. Cleaned, typed, deduped business entities. tenant_id on every table.
gold/                  Shared. Dimensional model. dim_*, fact_*, bridge_*. Feeds semantic model.
config/                Shared. Tenant registry, mapping tables, per-tenant integration config,
                       field-mapping tables. Mirrors Postgres via the sync notebook.
ops/                   Shared. Fabric-native operational tables (ingest logs, job runs, data
                       quality checks). Not mirrored from Postgres — read-write from notebooks.
```

### Delta only

Every managed table in the lakehouse is a **Delta** table. No plain Parquet, no CSV-backed tables, no external references. Every `CREATE TABLE` includes `USING DELTA`; every `DataFrame.write` uses `.format("delta")`. Rationale:

- Single storage format means one mental model for ACID, time travel, schema evolution, and MERGE semantics.
- Fabric's SQL endpoint, Direct Lake semantic models, and shortcuts all assume Delta — mixing formats creates sharp edges later.
- Bronze inherits this too. If a raw file is CSV/Excel, we *read* it with `spark.read.csv(...)` and *write* the result as Delta. The raw file stays in `Files/` as reference; the table in `Tables/` is always Delta.

### Bronze layout (per-tenant)

Each tenant gets its own schema. Tables within a tenant's bronze schema are prefixed by source:

```
bronze_acme.veeva_account
bronze_acme.veeva_call2
bronze_acme.sftp_<feed_name>
bronze_acme.email_<feed_name>
```

Bronze tables carry ingest metadata columns on top of whatever the source provides. `tenant_id` is **not** stored in bronze tables — it's implicit in the schema name and stamped when data flows to silver.

```
bronze_<slug>.veeva_account
  ingested_at       TIMESTAMP
  source_batch_id   STRING
  <all native Veeva columns, including tenant-specific __c fields>
```

### Silver layout

Silver is business entities, one row per entity per tenant:

```
silver.hcp, silver.hco, silver.territory, silver.call, silver.user, ...
```

All have `tenant_id`, natural key, surrogate key, type-safe columns, no multi-valued strings (unlike Fennec's `territory_ids` semicolon-delimited field — we explode into a bridge table).

### Gold layout

Star schema, tenant-aware:

```
gold.dim_hcp, dim_hco, dim_territory, dim_user, dim_date
gold.fact_call, fact_demand (867 + ex-factory + SP dispense unified), fact_inventory
gold.bridge_hcp_territory, bridge_call_owner_territory
```

### Config schema

```
config.tenant                 uuid, slug, name, status, created_at
config.tenant_veeva           tenant_id, vault_domain, username, password_secret_uri
config.tenant_sftp            tenant_id, host, username, key_secret_uri, base_path
config.tenant_email_drop      tenant_id, source_address, subject_pattern, feed_name
config.tenant_source_field_map
                              tenant_id, source_system, silver_table, silver_column,
                              bronze_source_table, bronze_source_column,
                              default_value, transform_sql
config.mapping                tenant_id, kind, source_key, target_value, effective_from, effective_to
config.tenant_user            tenant_id, user_email, role, effective_territory_ids  (used by PBI RLS)
```

Two distinct config tables for user-editable content:

- `config.tenant_source_field_map` — **technical field-level normalization** from per-tenant bronze to shared silver. Populated during onboarding by a schema-diff notebook + operator review. Consumed by silver-build notebooks.
- `config.mapping` — **business-level value mappings** (product hierarchy overrides, channel groupings, territory alignment, custom segmentation). Populated and edited by end users in the web app.

The distinction matters because the first is a one-time onboarding activity (changes when a client reconfigures their Vault); the second is ongoing operational work by brand managers and sales ops.

---

## 3. Naming & conventions

- **Tables:** `snake_case`, **singular** (`call`, not `calls`). Exception: Power BI display names can be Pascal.
- **Columns:** `snake_case`. No `Id`, no `ID` — always `<entity>_id`.
- **Timestamps:** `<event>_at` (e.g., `ingested_at`). Dates: `<event>_on`.
- **Tenant column (silver + gold):** `tenant_id UUID NOT NULL`, always the first column.
- **Bronze schemas:** `bronze_<tenant_slug>`. Tables within are source-prefixed: `veeva_*`, `sftp_<feed>`, `email_<feed>`, `hubspot_*`.
- **Tenant slug:** lowercase, hyphen-separated, 2–63 chars (same regex as `packages/shared/src/tenant.ts`). Used in bronze schema names and Key Vault secret paths.
- **Notebooks:** `<layer>_<purpose>.ipynb` (`bronze_veeva_ingest.ipynb`, `silver_build_hcp.ipynb`, `gold_fact_call.ipynb`).
- **Pipelines:** one per layer (`bronze_pipeline`, `silver_pipeline`, `gold_pipeline`) with activity-level dependencies. Or one master pipeline that calls each layer.
- **Semantic model:** Pascal display, snake underlying. No spaces in measure names.

Rule of thumb: if Fennec does X and Fennec is inconsistent about X, we pick one convention and enforce it.

---

## 4. Ingestion

### Veeva Vault

- Hardened fork of fennec's `accelerator.ipynb`.
- **Incremental-first** (Fennec has this code path but it's disabled — we enable from day one). Full refresh only on schema change or operator force.
- Notebook reads `config.tenant_veeva` → loops over enabled tenants → calls Direct Data API per tenant → writes bronze into that tenant's schema (`bronze_<tenant_slug>.veeva_*`). Table/column shape is derived from the Direct Data manifest per tenant — no hardcoded expected schema.
- Schedule: pipeline triggers at 8am ET (after Veeva's midnight ET FULL publishes) to avoid Fennec's silent-reprocess-of-yesterday bug.
- Retry: every notebook activity gets `retry: 2, retryIntervalInSeconds: 60`.

### Bronze → silver field mapping (the critical shift from Fennec)

Field mappings are **data-driven, not code-driven**. In Fennec, `DimHCP` has `t.name__v LIKE 'C1%'` and similar predicates baked into the notebook — that kind of expression breaks the moment tenant #2 has a different Vault config. In Throughline, the silver-build notebooks know nothing about specific tenants or specific field names; they read `config.tenant_source_field_map` and generate per-tenant SELECTs at runtime.

For each silver table + tenant, the map specifies which bronze column populates which silver column (plus optional default value and SQL transform). The build notebook generates one SELECT per tenant, UNION ALLs them into the shared silver table, stamping `tenant_id` as the first column.

**Onboarding a new tenant:**

1. Land their first Direct Data export into `bronze_<slug>.*`.
2. Run `tools/schema_diff.ipynb` — compares their bronze shape to the canonical silver spec, writes a best-guess `config.tenant_source_field_map`, and flags unmapped fields.
3. Operator or client CSM fills gaps (or confirms "drop") in the web admin UI.
4. Silver + gold builds run against their data.

Tenant-specific custom fields that don't fit the standard silver schema either drop (with a logged warning) or land in a per-tenant extension table (`silver.tenant_<slug>_<entity>_ext`) for that client's bespoke reporting only. Extension tables are *not* referenced by the shared semantic model.

### SFTP

- Each tenant gets a folder in an Azure Blob Storage account with SFTP protocol enabled: `sftp/<tenant_slug>/<feed_name>/<filename>`.
- Notebook scans blob paths, parses files against a per-tenant schema (header row or explicit column list), and lands into `bronze_<slug>.sftp_<feed_name>`. Shape reflects the client's file.
- The same `config.tenant_source_field_map` machinery normalizes bronze → shared silver per feed.
- Credentials managed via Entra IDs or SFTP keys, secrets in Key Vault.

### Email attachment

- Single shared mailbox (e.g., `ingest@<domain>`). Microsoft Graph API polls for unread messages.
- Subject-line convention: `[<tenant_slug>] <feed_name>` routes the attachment to the right tenant + feed.
- Attachment written to blob (same path pattern as SFTP), then lands in `bronze_<slug>.email_<feed_name>`. Same field-map normalization to silver.
- Messages marked as read or moved to `Processed/` after landing.

### HubSpot (future, post-MVP)

- Per-tenant OAuth, tokens in Key Vault.
- Fabric native connector if available at build time; else Azure Function pulling incrementally.
- Drops into `bronze_<slug>.hubspot_*`, flows through silver/gold via the same field-map normalization as everything else.

---

## 5. Semantic model & RLS

One Power BI semantic model (`.tmdl`) committed under `data/` via Fabric Git integration. Sits on `gold.*` tables.

### RLS pattern

Two roles:

1. **DefaultUser** — dynamic filter:
   ```
   [Email] = USERPRINCIPALNAME()
   ```
   applied on `dim_user`. Relationships propagate: `dim_user` → `dim_territory` → all facts filter to the user's effective territories. `tenant_id` gets filtered transitively because `dim_user.tenant_id` → facts' `tenant_id`.

2. **BypassTenant** — no filter. Granted only to JJW/Sentero operator admins for support. Usage logged.

### Embed token generation

Web app backend generates tokens using service principal (`POWERBI_CLIENT_ID` + `POWERBI_CLIENT_SECRET`):

```
generateTokenInGroup(workspaceId, {
  accessLevel: "View",
  identities: [{
    username: user.email,
    roles: ["DefaultUser"],
    datasets: [datasetId],
  }],
})
```

RLS then does the rest. Do **not** pass `tenant_id` in identity — it's derived via the model.

---

## 6. Config & secrets

- **App state (Postgres):** tenants, users, roles, mapping-table writes, audit log, billing. Users edit mappings in the web app; writes land here and are pushed to `config.mapping` in Fabric (nightly sync, or on-demand).
- **Tenant integration config (Fabric `config` schema):** non-secret parameters for Veeva/SFTP/email/HubSpot. Populated by the web admin UI, consumed by notebooks.
- **Secrets (Azure Key Vault):** one vault. Key pattern: `<tenant_slug>--<service>--<key_name>` (e.g., `acme-pharma--veeva--password`).
- **Fabric → Key Vault:** capacity managed identity gets `get` permission. Notebooks use `mssparkutils.credentials.getSecret(<vault_url>, <key_name>)`.
- **Web → Key Vault:** Next.js uses `@azure/identity` with the app's managed identity (when deployed) or service principal env vars (local dev).

---

## 7. Environments & deployment

| Env | Fabric workspace | Git branch | Web deploy |
|---|---|---|---|
| Dev | `throughline-dev` | `main` | Vercel preview / local |
| Prod | `throughline-prod` | `release` | Vercel production |

- PR merged to `main` → Fabric Git auto-syncs into dev workspace.
- Manual promote: merge `main` → `release` triggers Fabric sync into prod workspace + Vercel prod deploy.
- No direct edits in prod workspace. If Fabric detects drift, it blocks sync until dev and prod are reconciled.

---

## 8. Capacity & cost

**Dev (now):** F2 with pause/resume discipline.

- F2 list: ~$263/mo pay-as-you-go (Central US).
- Pause nights + weekends via Azure automation → ~$75–100/mo actual.
- F2 is slow for large Spark jobs but fine for small-tenant dev volumes.

**First customer:** bump prod workspace to F4 (~$526/mo list, ~$316/mo reserved 1yr). Keep dev on F2.

**Scale path:**

| Tier | SKU | Approx tenants | Approx monthly |
|---|---|---|---|
| Early | F4 | 1–3 small | $316–526 |
| Growth | F8 | 3–8 | $632–1,050 |
| Mid | F16 | 8–20 | $1,265–2,105 |
| Scale | F32+ | 20+ | $2,530+ |

Fabric capacity scales without downtime. Don't over-provision early.

**Pause script:** provisioned outside of Fabric, in `infra/` — scheduled Azure runbook or GitHub Action calling `az fabric capacity suspend`.

---

## 9. Fennec anti-patterns we will not repeat

Numbered for reference in PRs:

1. **Hardcoded workspace/lakehouse/territory IDs *and source-field predicates* in notebooks.** All config — including which bronze column maps to which silver column — comes from `config.*` tables or env. No more `LIKE 'C1%'` baked into a transform.
2. **Disabled incremental ingest.** Ingest is incremental-first from day one; full refresh is opt-in.
3. **Zero retry on pipeline activities.** Every activity: `retry: 2, retryIntervalInSeconds: 60`.
4. **Semicolon-delimited multi-value columns** (`territory_ids`). We explode into bridge tables.
5. **Manual override tables that no notebook creates.** Any table the pipeline depends on is created idempotently by a notebook or migration.
6. **Pipeline runs before source publishes.** Schedule Veeva ingest after Vault's daily publish time.
7. **Inline SQL in `.tmdl` files.** Semantic model reads from clean `gold.*` tables; no in-PBI transforms.
8. **Bidirectional relationships by default.** Only enable when a specific measure requires it, documented inline.
9. **Zero tests.** Every notebook gets a test harness that runs on a synthetic tenant seed before merge.
10. **Single-operator email bound to pipeline notifications.** Alerts go to a distribution list or ops channel, not a person.

---

## Open items (not yet decided)

- **App DB hosting:** Supabase vs. Azure Postgres Flex. Leaning Azure Postgres for SOC2 story when enterprise deals appear.
- **CI provider:** assumed GitHub Actions.
- **Pause/resume automation:** Azure Automation runbook vs. GitHub Action vs. Logic App. TBD when we actually write it.
- **Audit log storage:** Postgres table (simple) vs. Event Grid → blob (compliant). Start simple, promote when a customer asks.
