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

## Build state (snapshot 2026-04-24)

### Working end-to-end against fennec's real Veeva data

**Data plane (Fabric)**
- **Bronze ingest:** SFTP file drop (CSV → Delta), Veeva Direct Data API (FULL daily + incremental ~15-min batches with cursor-tracked idempotency in `ops.veeva_ingest_log`)
- **Silver layer (8 entities):** `picklist`, `hcp` (78,668), `hco` (24,938), `user` (91), `territory` (50, with team_role derivation), `call` (22,814), `account_territory` (~225k bridge), `user_territory` (~80 bridge), `account_xref` (synthetic SFTP fixture)
- **Gold layer (5 tables):** `dim_date` (2020–2030), `dim_hcp`, `dim_hco` (newly promoted), `dim_user` (with `is_active` + `is_field_user` flags), `fact_call` (with `hcp_key`, `hco_key`, and `credit_user_key` COALESCE pattern)
- **Direct Lake semantic model:** all 5 gold tables wired with relationships + tenant RLS via `customData`
- **Config plane:** Postgres → Fabric `config.*` sync notebook keeps the two stores aligned

**Web app (Next.js)**
- **Native dashboards as default**, PBI embed reserved for deep analysis at `/reports/[id]`. See [docs/product/web-display-philosophy.md](docs/product/web-display-philosophy.md).
- `/dashboard` — KPI cards (Interactions / HCPs reached / Active reps), trend chart, top reps + top HCPs/HCOs tables, account toggle (HCP/HCO/All), filter bar (range / channel), all RLS-scoped and clickable through to detail pages
- `/reps/[user_key]`, `/hcps/[hcp_key]`, `/hcos/[hco_key]` — entity detail pages with KPIs, trend, related-entity tables
- `/inbox` — AI-driven signals view: HCP inactivity, activity drop, over-targeting; LLM-generated priority brief at top via Anthropic API
- `/admin/users` — invite flow with "Invite from Veeva" primary path (lists active reps from `gold.dim_user` with click-to-invite) + manual escape hatch; provisioned-users audit table
- `/admin/tenants` — tenant CRUD
- **RLS:** per-user role + scope (`admin` / `manager` / `rep` / `bypass`), enforced at the query layer in `apps/web/lib/scope.ts`. See [docs/architecture/rls.md](docs/architecture/rls.md).
- **Auth + provisioning:** Clerk middleware-protected routes; `/api/webhooks/clerk` auto-provisions `tenant_user` rows from invite metadata. See [docs/architecture/clerk-webhooks.md](docs/architecture/clerk-webhooks.md).

### Not yet wired

- `gold.dim_territory`, `gold.bridge_user_territory`, `gold.bridge_hcp_territory` — territory rollups blocked here; manager scope falls back to `manager_id` hierarchy.
- `gold.bridge_hcp_hco` (HCP↔HCO affiliations) — deferred until sales fact lands; the high-value use case ("$$ at this institution via these HCPs") only materializes when both exist.
- `silver.user_territory_assignment_scd2` for point-in-time rep attribution (current bridge is current-state only).
- Mislabeled `gold.fact_call.status` column — always "Active" (account-flag carry-through). Use `call_status` for real Veeva status. Cleanup pending next gold rebuild.
- **Goals** — entire KPI category, no ingest exists. Biggest pharma KPI gap. See [docs/product/goals.md](docs/product/goals.md).
- **Sales fact** — entire revenue side missing; needs source decision.
- Production scheduling — every notebook runs manually today.
- Tenant variability rules registry — hardcoded per-fennec rules with comments marking them; refactor when tenant #2 lands.
- `user.deleted` webhook handler for offboarding; Clerk user delete leaves the `tenant_user` row.
- Tests. Architecture §9.9 calls for them; we have zero.

### Immediate next milestone

**Goals product design** — pick the data shape (file upload vs form-entry vs scheduled sync), then build ingest + dashboard surfaces. Goal-attainment is the #1 pharma KPI per the catalog mining; everything else is incremental.

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
