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

## Build state (snapshot 2026-04-28, updated end-of-day)

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
- `/dashboard` — KPI cards (Interactions w/ calls-goal attainment, HCPs/HCOs reached, Active reps, **Net Units** w/ units-goal attainment + dollars sub-line). Calls + sales trends w/ pace overlay (territory-entity goals). **Top HCOs by Units**, **Top reps by Units**, **Top rising / Top declining accounts** (period-over-period), **Watch list** (had-prior-now-zero), **New accounts** (first-ever sale in window), **HCP tier coverage** panel (% contacted by tier within scope), **Team rollup** (manager/admin: per-rep calls + units attainment, sortable, drill-into rep). **"Since your last visit" synopsis card** at top — LLM-generated narration of what changed since the last data refresh (cached per (user × pipeline_run), 4h rate-limit between regenerations, dismissible until next refresh). FilterBar: range / granularity / channel / **Territory** (admin sees all; manager sees team; rep sees own). MTD/QTD/YTD presets. RLS-scoped throughout.
- `/explore` — generic matrix surface w/ pickers for **Group by + Rows + Metric + Time grain**. Row dims: HCO, HCP, HCO type, **HCO affiliation** (HCP's primary parent HCO), HCP tier, HCP specialty, Channel, Territory. Metrics: Calls, Net Units, Net Dollars. Multi-dim grouping renders bold group headers w/ accurate subtotals + indented sortable leaves. Click any column header to sort (DESC/ASC toggle); Download CSV button serializes the displayed view. URL state encodes every pick — views are bookmarkable.
- `/ask` — **conversational analytics chat surface**. 8 RLS-scoped tools: `query_top_accounts`, `query_account_motion` (rising/declining/watch), `lookup_entity` (fuzzy HCO/HCP), `lookup_territory` (fuzzy by description or Veeva code), `query_rep_summary` (per-rep KPIs + trend), `query_tier_coverage` (with `breakdown=by_rep` + tier-label substring filter), `query_entity_detail` (per-HCO sales trend / per-HCP call detail), `query_goal_attainment` (single entity OR worst-N ranked). Tool calls visible inline (collapsed pills) for trust/auditability. Conversations don't persist; refresh = new chat. Claude Opus 4.7 with parallel tool use.
- `/reps/[user_key]` — calls KPIs + trend + Top HCPs (existing) + **Net Units card + sales trend + Top HCOs by Units** + **Coverage HCOs** section (multi-visibility, all bridged HCOs with Primary/Co-coverage badges per Option B hybrid model). **"Suggested this week" LLM card** with 3-5 prioritized HCP/HCO recommendations + per-row "Show context" expand panel (affiliated HCPs at the HCO + sales mini-trend for HCO suggestions; parent HCO + recent calls for HCP suggestions). Cached per (rep × pipeline_run), 4h rate-limit. Tier-aware weighting in the prompt; underactive coverage (HCOs in book with zero calls via affiliated HCPs in last 8 weeks) as a primary input.
- `/hcps/[hcp_key]` — calls-focused detail (sales rarely attributed at HCP grain in 867 data).
- `/hcos/[hco_key]` — calls + sales surfaces (units-primary). **Sales attribution** section showing every territory the HCO is bridged to with primary flag, current rep, assignment source. Veeva ID surfaced for cross-reference.
- `/inbox` — AI-driven signals: HCP inactivity, activity drop, over-targeting, goal pace behind (calls + sales — territory-entity), **unmapped-accounts** (admin-only). LLM priority brief at top.
- `/admin/goals` — recommendation-driven form. **Calls goals at REP entity**. **Units goals at TERRITORY entity** (pharma standard; reps come/go but goal stays with territory). Territory display shows description (geographic) over Veeva code. CSV upload + template per metric/entity (territory CSV emits both description + name columns; upload accepts either). Period picker w/ reactive Month/Quarter/Year snap.
- `/admin/mappings` — Smart CSV uploader (column mapper + preview + auto-detect synonyms), multi-field resolution (veeva_account_id / network_id / npi / dea_number / aha_id), per-row picker w/ HCO-only fuzzy suggestions (Jaro-Winkler), saved-mappings list with inline edit/delete + search, "Run sync now" button triggers `mapping_propagate_pipeline`. Postgres-authoritative for "Needs mapping".
- `/admin/users` — Invite flow with "Invite from Veeva" + manual escape hatch.
- `/admin/tenants` — tenant CRUD.
- `/admin/pipelines` — pipeline health monitor (last run + status per kind, recent runs table with expandable step_metrics + error JSON).
- `/admin/attributes` — Phase 1 of the tenant-custom HCP/HCO scoring attributes architecture. Admin UI to declare which bronze columns are scoring attributes (Komodo deciles, Clarivate volumes, IQVIA Rx, etc.) — cascading dropdowns: source system → bronze table (introspected from tenant's bronze schema via `INFORMATION_SCHEMA`) → bronze column (lazy-fetched on table select) → auto-suggested canonical attribute name. Saves to `tenant_attribute_map` Postgres table. Phase 2 (silver/gold notebooks + LLM input wiring) not yet built — spec at `docs/architecture/tenant-custom-attributes.md`.
- **RLS:** per-user role + scope (`admin` / `manager` / `rep` / `bypass`), enforced at query layer in `apps/web/lib/scope.ts`. **Sales loaders rewrite `owner_user_key` → `rep_user_key` for fact_sale RLS.** **Calls territory filter** uses HCP-in-territory via `bridge_account_territory` (current-state; SCD2 deferred per `project_owner_temporal_scd2_followup`).
- **Auth + provisioning:** Clerk middleware-protected; `/api/webhooks/clerk` provisions `tenant_user`.

### Not yet wired (current pending list)

- **HCO affiliation on /explore picker** — code shipped; needs silver_hcp + gold_dim_hcp rebuild + field-map re-seed to populate `primary_parent_hco_key`/`name` on `dim_hcp`. Picker entry will return empty until then.
- **Pipeline-as-DataPipeline** — `.DataPipeline` git-synced items would let schedules live in code (vs hand-set per Fabric workspace). Notebook orchestrators work today; this is a polish migration.
- **Per-tenant rules registry** — TEAM_ROLE_RULES, ELIGIBLE_REP_TYPES, etc. hardcoded per tenant in notebook constants. End state: editable from /admin. Refactor when tenant #2 lands. (See `project_tenant_specific_rules_registry` memory.)
- **Mapping kinds beyond account_xref** — schema supports product/territory/hco_channel/customer_type. UI only handles account_xref today.
- **Owner-temporal SCD2 territory attribution** — current model is HCP-in-territory current-state. Fennec's stricter end-state (call pinned to rep's territory at call time) is the eventual fix. See `project_owner_temporal_scd2_followup` memory + `docs/product/matrix-tables.md`.
- `gold.fact_call.hco_key` — missing; calls territory filter approximates via HCP affiliation. HCO-type-by-Calls in /explore is disabled until this lands.
- Mislabeled `gold.fact_call.status` column — always "Active" (account-flag carry-through).
- Tests. Architecture §9.9 calls for them; we have zero.
- `user.deleted` Clerk webhook handler for offboarding.

### Immediate next milestone

**LLM expansion v1 SHIPPED.** All three surfaces from `docs/product/llm-expansion.md` are live: synopsis (`/dashboard`), action recommendations (`/reps/[user_key]`), conversational analytics (`/ask`). Each uses the narrator-over-input pattern (LLM never invents — every fact comes from a tool result), per-(entity × pipeline_run) caching with 4h rate-limit, and tenant + role isolation enforced at the loader layer.

**Next major lift:** tenant-custom HCP/HCO attributes Phase 2 (silver_hcp_attribute_build + silver_hco_attribute_build notebooks, gold rollup tables, composite `gold.hcp_target_score`, LLM input wiring via the existing `predictions.hcp_target_scores` placeholder field on rep-recommendations input). Phase 1 (schema + admin UI + migration) is live 2026-04-28; admins can configure mappings now but they sit inert until Phase 2 builds the ingestion. Spec at `docs/architecture/tenant-custom-attributes.md`. Until Phase 2 lands, action recommendations on `/reps/[user_key]` lean on coverage + motion signals only.

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
