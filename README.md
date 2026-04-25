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

## Build state (snapshot 2026-04-25)

### Working end-to-end against fennec's real Veeva + sales data

**Data plane (Fabric)**
- **Bronze ingest:** SFTP file drop (CSV → Delta with column-mapping enabled for non-standard column names like `sum(867 Qty Sold (EU))`); Veeva Direct Data API (FULL daily + incremental ~15-min batches with cursor-tracked idempotency in `ops.veeva_ingest_log`)
- **Silver layer (9 entities):** `picklist`, `hcp` (78k), `hco` (25k), `user` (91), `territory` (50, with team_role derivation), `call` (22.8k), `account_territory` (225k bridge), `user_territory` (80 bridge), `account_xref` (now sourced from CSV bronze + Postgres UI mappings, deduped UI-wins), `sale` (1k+ from IntegriChain 867; daily grain; type-safe casts; snapshot vs incremental cadence per `tenant_sftp_feed`)
- **Gold layer (7 tables):** `dim_date` (rich: business days, US holidays, relative day/week/quarter), `dim_hcp`, `dim_hco`, `dim_user`, `fact_call`, `fact_goal` (mirror of Postgres goals via `goals_sync` notebook), `fact_sale` (account resolved via account_xref → dim_hcp/dim_hco; signed measures for net math; transfers filtered)
- **Direct Lake semantic model:** all gold tables wired with relationships + tenant RLS via `customData`
- **Config plane:** Postgres → Fabric `config.*` sync covers tenant, mappings, field maps, sftp feed cadence, sftp/email/veeva integration metadata, tenant_user

**Web app (Next.js)**
- **Native dashboards as default**, PBI embed reserved for deep analysis at `/reports/[id]`. See [docs/product/web-display-philosophy.md](docs/product/web-display-philosophy.md).
- `/dashboard` — KPI cards (Interactions / HCPs reached / Active reps with attainment vs goals), pace-aware trend chart with goal overlay line, top reps + top HCPs/HCOs tables, account toggle (HCP/HCO/All), filter bar (range / granularity Week/Month/Quarter / channel), MTD/QTD/YTD presets alongside rolling ranges, all RLS-scoped and clickable through to detail pages
- `/reps/[user_key]`, `/hcps/[hcp_key]`, `/hcos/[hco_key]` — entity detail pages with KPIs (vs goal where defined), trend, related-entity tables
- `/inbox` — AI-driven signals: HCP inactivity, activity drop, over-targeting, **goal pace behind**; LLM-generated priority brief at top via Anthropic API
- `/admin/goals` — recommendation-driven form (auto-fills suggestions from historical actuals + peer median + LLM rationale via "?" button), CSV upload with pre-populated template, period picker with reactive Month/Quarter/Year snap
- `/admin/mappings` — "Needs mapping" list (top unmapped distributor accounts from `gold.fact_sale`); per-row search-and-pick UI hitting `dim_hcp` + `dim_hco`; saved mappings audit table; writes to Postgres `mapping` table (kind=account_xref) → mirrors via config_sync, propagates via silver_account_xref_build + gold_fact_sale_build
- `/admin/users` — invite flow with "Invite from Veeva" primary path (lists active reps from `gold.dim_user` with click-to-invite) + manual escape hatch
- `/admin/tenants` — tenant CRUD
- **RLS:** per-user role + scope (`admin` / `manager` / `rep` / `bypass`), enforced at the query layer in `apps/web/lib/scope.ts`. See [docs/architecture/rls.md](docs/architecture/rls.md).
- **Auth + provisioning:** Clerk middleware-protected routes; `/api/webhooks/clerk` auto-provisions `tenant_user` rows from invite metadata. See [docs/architecture/clerk-webhooks.md](docs/architecture/clerk-webhooks.md).

### Not yet wired

- **Sales metrics on dashboard** — `gold.fact_sale` exists end-to-end but no Net Sales card / Sales-by-quarter trend / Sales-vs-Goal visualization yet.
- **CSV upload on `/admin/mappings`** — per-row UI works; bulk CSV upload (matching the goals upload pattern) is queued.
- **Unmapped-accounts signal in `/inbox`** — surface the high-impact unmapped accounts as work-to-do for the mapping admin.
- `gold.dim_territory`, `gold.bridge_user_territory`, `gold.bridge_hcp_territory` — territory rollups blocked here; manager scope falls back to `manager_id` hierarchy.
- `gold.bridge_hcp_hco` (HCP↔HCO affiliations) — high-value once we have sales (rolls HCP-level prescribing to HCO institutions).
- `silver.user_territory_assignment_scd2` for point-in-time rep attribution (current bridge is current-state only).
- Mislabeled `gold.fact_call.status` column — always "Active" (account-flag carry-through). Use `call_status` for real Veeva status.
- Production scheduling — every notebook runs manually today.
- Tenant variability rules registry — hardcoded per-fennec rules with comments marking them; refactor when tenant #2 lands.
- Mapping kinds beyond account_xref (product, territory, hco_channel, customer_type) — schema supports them, UI doesn't render them yet.
- `user.deleted` webhook handler for offboarding.
- Tests. Architecture §9.9 calls for them; we have zero.

### Immediate next milestone

**Surface sales on the dashboard** — Net Sales card, Sales-by-quarter trend with goal-pace overlay, top accounts by net dollars. Plus the unmapped-accounts signal in `/inbox` so mapping work surfaces as part of the inbox flow.

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
