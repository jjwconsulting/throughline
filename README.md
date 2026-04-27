# Throughline *(placeholder name — rename before launch)*

Commercial analytics SaaS for life sciences. A JJW Consulting + Sentero Pharma joint venture.

> **Name note:** "Throughline" is a working codename. The real brand hasn't been chosen. To rename: global find/replace `throughline` → `<newname>` (and `@throughline/` → `@<newname>/`) across the repo, then rename the root directory.

## What this is

A multi-tenant SaaS that ingests life-sciences commercial data (Veeva Vault + SFTP/email file drops + eventually HubSpot and others), transforms it in **Microsoft Fabric**, and surfaces it through native React dashboards (with embedded Power BI reserved for deep self-service analysis). The app hosts the analytics surfaces, an AI-driven inbox of insight signals, user-editable mapping tables, custom groupings, and admin.

## Layout

```
throughline/
├── apps/
│   └── web/                  Next.js 16 app (marketing + auth'd app shell + Power BI embed)
├── packages/
│   └── shared/               TS types + Zod schemas shared across apps
├── data/                     Fabric-owned. Git integration syncs notebooks, pipelines,
│                             and semantic models into this folder.
├── infra/                    Bicep/Terraform for Azure + Fabric
├── ARCHITECTURE.md           Multi-tenancy, Lakehouse, RLS, ingestion, capacity decisions
├── README.md                 This file
└── CLAUDE.md                 Context for future Claude sessions
```

## Getting started

```bash
pnpm install
pnpm dev              # starts apps/web on :3000
```

Requires Node 20+ and pnpm 9+.

## Architecture decisions (locked in)

- **Data plane:** Microsoft Fabric, single workspace, multi-tenant via `tenant_id` column + Power BI RLS
- **Web:** Next.js 16 + TypeScript + Tailwind v4
- **Auth:** Clerk for MVP → Entra/Azure AD B2B when first enterprise pharma asks
- **App DB:** Postgres (Supabase or Azure Postgres Flex) — app state only, analytics stays in Fabric
- **Power BI embed:** app-owns-data via service principal, **Direct Lake** semantic model with `customData`-based RLS (see ARCHITECTURE.md §5 for the cloud-connection binding setup)
- **Billing:** Stripe (self-serve tiers); enterprise = annual MSA separate

## Build state (snapshot 2026-04-27)

### Working end-to-end against fennec's real Veeva + sales data

**Data plane (Fabric)**
- **Bronze ingest:** SFTP file drop (CSV → Delta with column mapping for non-standard column names like `sum(867 Qty Sold (EU))`); Veeva Direct Data API (FULL daily + incremental ~15-min batches with cursor-tracked idempotency)
- **Silver layer (9 entities):** `picklist`, `hcp` (78k, w/ `network_id` + `npi` + `dea_number`), `hco` (25k, same identifier set), `user` (91), `territory` (50, name-pattern team_role derivation: M%=MSL, C8%=KAD, C%=SAM), `call` (22.8k), `account_territory` (225k bridge), `user_territory` (80 bridge), `account_xref` (CSV bronze + Postgres UI mappings, UI wins), `sale` (1k+ from IntegriChain 867; daily grain; snapshot vs incremental cadence per `tenant_sftp_feed`). Silver builds tolerant of missing bronze columns (NULLs + warning instead of crash).
- **Gold layer (10 tables):** `dim_date`, `dim_hcp`, `dim_hco` (with `network_id`, `npi`, `dea_number`), `dim_user`, `dim_account`, **`dim_territory`** (with `current_rep_user_key`, Sales-only filter), **`bridge_account_territory`** (with `is_primary` flag — primary-pick: has-rep first, then SAM > KAD > ALL > MSL, then manual > rule), `fact_call`, `fact_goal` (mirror of Postgres goals via `goals_sync`), **`fact_sale`** (account resolved via account_xref → dim_hcp/dim_hco; **`territory_key` + `rep_user_key` populated via bridge → dim_territory current rep**; `attribution_status` records cascade outcome; ~98% attribution on fennec data; signed measures; transfers filtered)
- **Direct Lake semantic model:** all gold tables wired with relationships + tenant RLS via `customData`
- **Config plane:** Postgres → Fabric `config.*` sync covers tenant, mappings, field maps, sftp feed cadence, integration metadata, tenant_user

**Pipeline orchestration (Fabric)**
- **4 orchestrator notebooks** with Supabase REST writeback to `pipeline_run`:
  - `incremental_refresh_pipeline` — daily 2am dev / 30-60min prod. Veeva incremental + SFTP + all silver/gold builds.
  - `weekly_full_refresh_pipeline` — Sunday 2am. `veeva_full_ingest` + complete rebuild.
  - `delta_maintenance_pipeline` — Sunday 4am. `OPTIMIZE` + `VACUUM RETAIN 168` across silver/gold.
  - `mapping_propagate_pipeline` — admin-triggered via /admin/mappings. Polling-based handoff (Fabric param-tag handoff is unreliable).
- **`/admin/pipelines`** is the customer-facing health monitor: read-only for global pipelines, manual trigger only for tenant-scoped.
- Service-role secret loaded from lakehouse `Files/secrets/pipeline_config.json` (NOT git-synced) using Supabase legacy JWT format.

**Web app (Next.js)**
- `/dashboard` — KPI cards (Interactions, HCPs/HCOs reached, Active reps, **Net Units** w/ dollars sub-line). Calls trend w/ goal pace overlay. **Sales trend (units-primary)**. **Top HCOs by Units**, **Top reps by Units** (with "Unattributed" pseudo-row), **Top distributors (unmapped)**. Filter bar (range / granularity / channel), MTD/QTD/YTD presets. RLS-scoped throughout.
- `/reps/[user_key]` — calls KPIs + trend + Top HCPs (existing) + **Net Units card + sales trend + Top HCOs by Units** (new) + **Coverage HCOs** section (multi-visibility, all bridged HCOs with Primary/Co-coverage badges per Option B hybrid model).
- `/hcps/[hcp_key]` — calls-focused detail (sales rarely attributed at HCP grain in 867 data).
- `/hcos/[hco_key]` — calls + sales surfaces (units-primary). **Sales attribution** section showing every territory the HCO is bridged to with primary flag, current rep, assignment source. Veeva ID surfaced for cross-reference.
- `/inbox` — AI-driven signals: HCP inactivity, activity drop, over-targeting, goal pace behind (calls), **unmapped-accounts** (admin-only). LLM priority brief at top.
- `/admin/goals` — recommendation-driven form. **Calls goals at REP entity** (existing). **Units goals at TERRITORY entity** (new — pharma standard; reps come/go but goal stays with territory). CSV upload + template per metric/entity. Period picker w/ reactive Month/Quarter/Year snap.
- `/admin/mappings` — Smart CSV uploader (column mapper + preview + auto-detect synonyms), multi-field resolution (veeva_account_id / network_id / npi / dea_number / aha_id), per-row picker w/ HCO-only fuzzy suggestions (Jaro-Winkler), saved-mappings list with inline edit/delete + search, "Run sync now" button triggers `mapping_propagate_pipeline`. Postgres-authoritative for "Needs mapping".
- `/admin/users` — Invite flow with "Invite from Veeva" + manual escape hatch.
- `/admin/tenants` — tenant CRUD.
- `/admin/pipelines` — pipeline health monitor (last run + status per kind, recent runs table with expandable step_metrics + error JSON).
- **RLS:** per-user role + scope (`admin` / `manager` / `rep` / `bypass`), enforced at query layer in `apps/web/lib/scope.ts`. **Sales loaders rewrite `owner_user_key` → `rep_user_key` for fact_sale RLS.**
- **Auth + provisioning:** Clerk middleware-protected; `/api/webhooks/clerk` provisions `tenant_user`.

### Not yet wired (current pending list)

- **Sales goals surfacing** — territory-entity entry ships; pace overlay on Net Units card / sales trend, /reps "effective goal" attainment, /inbox sales-pace signal all queued for next session.
- **Territory display polish** — render `description` (geographic, "Los Angeles") as primary label, code (`C103`) as subtitle. Apply to goals form + coverage views + attribution chain.
- **Pipeline-as-DataPipeline** — `.DataPipeline` git-synced items would let schedules live in code (vs hand-set per Fabric workspace). Notebook orchestrators work today; this is a polish migration.
- **Per-tenant rules registry** — TEAM_ROLE_RULES, ELIGIBLE_REP_TYPES, etc. hardcoded per tenant in notebook constants. End state: editable from /admin. Refactor when tenant #2 lands. (See `project_tenant_specific_rules_registry` memory.)
- **Mapping kinds beyond account_xref** — schema supports product/territory/hco_channel/customer_type. UI only handles account_xref today.
- `silver.user_territory_assignment_scd2` for point-in-time attribution (current is current-state only — see SCD2 limitation noted on Phase A surfaces).
- `gold.bridge_hcp_hco` (HCP↔HCO affiliations) — high-value once we add prescribing data.
- Mislabeled `gold.fact_call.status` column — always "Active" (account-flag carry-through).
- Tests. Architecture §9.9 calls for them; we have zero.
- `user.deleted` Clerk webhook handler for offboarding.

### Immediate next milestone

**Phase B surfacing — sales goals on the dashboard.** Net Units KPI card → attainment label when a tenant-wide units goal exists. Sales trend → dashed pace ReferenceLine. /reps page → "effective goal" = sum of territories where rep is current_rep, with attainment + pace overlay. /inbox → "Behind on sales pace" signal (mirrors loadGoalPaceSignals for calls).

## Still open

- Product name (current placeholder: Throughline)
- Fabric SKU sizing (depends on first-customer data volume + embed concurrency)
- Mapping-table UI framework (TanStack Table + React Hook Form + Zod is the likely stack)
- CI provider (GitHub Actions assumed)
- Goals structure — form-entry vs file-upload vs both; table shape; post-MVP. See [docs/product/goals.md](docs/product/goals.md)
- SFTP hosting for prod — dev uses lakehouse `Files/` as drop zone; prod TBD (VM with OpenSSH + BlobFuse vs Azure Storage SFTP)
- AI/ML surfaces — conversational analytics, targeting ML, forecasting, call-log NLP. Future-state, see [docs/product/ai-layer.md](docs/product/ai-layer.md)
- User access flow — invite vs self-signup, roles, tenant switcher, BypassTenant, deprovisioning. See [docs/product/user-access.md](docs/product/user-access.md)
- Tenant variability rules registry — currently hardcoded per fennec's quirks; refactor when tenant #2 lands. See [docs/architecture/tenant-variability.md](docs/architecture/tenant-variability.md)
- Web display philosophy — native React rendering by default, PBI embed reserved for self-service and deep analysis. See [docs/product/web-display-philosophy.md](docs/product/web-display-philosophy.md)

## What not to repeat from fennec

Tracked in `ARCHITECTURE.md` §9. TL;DR: no hardcoded IDs, incremental-first ingest, retry on every pipeline activity, bridge tables instead of semicolon-delimited strings, tests before merge.
