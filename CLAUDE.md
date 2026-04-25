# Context for Claude sessions

## Product
Life-sciences commercial analytics SaaS. JV between JJW Consulting (James Waterman) and Sentero Pharma (St. Louis, rare-disease commercial consulting). Target buyers: pharma/biotech commercial ops, brand leads, field analytics.

## Name
`throughline` is a **placeholder**. Real name TBD. All code uses `throughline` / `@throughline/*` — renaming is a global find/replace. Do not propagate the placeholder into any user-facing copy without flagging it.

## Architecture
- **Data plane:** Microsoft Fabric, single workspace, multi-tenant. Every fact/dim has a `tenant_id` column. Power BI RLS scopes per user via `EffectiveIdentity`.
- **Web:** Next.js 16 App Router, TypeScript strict, Tailwind v4 (via `@tailwindcss/postcss`). Light theme, not dark.
- **Auth:** Clerk (MVP). Plan migration to Entra/Azure AD B2B for enterprise SSO.
- **App DB:** Postgres. Holds tenants, users, mapping tables, audit log. Analytics data lives in Fabric.
- **Power BI embed:** app-owns-data, service principal in `.env`.
- **Billing:** Stripe self-serve; enterprise via MSA.

## Reference repos on disk
- `C:\Users\jwate\fennec` — closest analog for the data plane. Single-tenant, hardcoded IDs. **Reuse patterns, not code verbatim.**
- `C:\Users\jwate\TriSalus` — KPI / report catalog only. Don't reuse code.
- `C:\Users\jwate\golf-betting-site` — design/UX reference. Dark theme; we're going light. Reuse AppShell/nav patterns, not domain logic.

## Constraints
- **Do not** introduce hardcoded workspace IDs, lakehouse names, or territory roots.
- **Do not** copy fennec's disabled-incremental-ingest pattern — incremental must work from day one.
- **Do** build native React components as the default UI pattern; reserve PBI embed for self-service and deep analysis (see `docs/product/web-display-philosophy.md`).
- **Do** require a `tenant_id` on every Fabric table schema from the first migration.
- **Do** write tests before porting a fennec notebook — fennec has zero test coverage and that's not surviving into SaaS.
- **Do** respect tenant-specific hardcoded rules in silver builds with inline comments — they'll move to a config registry when tenant #2 lands (see `docs/architecture/tenant-variability.md`).

## Current status (2026-04-25)
Bronze → silver → gold all built and tested against fennec's live Veeva data PLUS sales (IntegriChain 867). The web app is a real V1 multi-tenant SaaS:
- Native dashboards (KPIs vs goal / pace-aware trend / drilldowns) backed by `gold.fact_call` + soon `gold.fact_sale` joined to `dim_hcp` / `dim_hco` / `dim_user` / `dim_date`
- AI signals + LLM-narrated `/inbox` (Anthropic API) — HCP inactivity, activity drop, over-targeting, goal-pace
- Goals product end-to-end: recommendation engine + form + CSV upload + dashboard surfacing + `/inbox` pace alerts
- Mappings UI at `/admin/mappings` (per-row search-and-pick for distributor↔Veeva account_xref)
- Per-user RLS (admin / manager / rep / bypass) at the query layer
- Clerk webhook → `tenant_user` provisioning, with `/admin/users` "Invite from Veeva" flow
- PBI embed demoted to `/reports/[id]` for deep self-service analysis only
- Per-feed snapshot/incremental cadence config (`tenant_sftp_feed`) drives silver build batch-selection

**See README.md "Build state" section** for specifics + the immediate-next-milestone (sales metrics on dashboard).

## Architectural patterns we settled on
- **Postgres = canonical for admin-edited state** (goals, mappings, tenant_user, tenant config). Web app interactive reads go to Postgres.
- **Fabric = downstream analytics mirror** (config_sync, goals_sync, etc.). PBI / SQL JOINs / scheduled analytics use these. Sync-lagged; never read for fresh-write displays.
- **Bronze CSV import + UI per-row** is the pattern for both goals AND mappings. Bulk for day-1 setup, UI for ongoing.
- **Recommendation-driven defaults** (goals form pre-fills with statistical recommendations + LLM rationale on demand). The 80/20 framing — auto-recommend the 80%, easy tweak for the 20% with conviction.
- **Signed measures** in fact tables for net-math (`-ABS()` on RETURNS so source convention doesn't matter).

## Orientation for new sessions
Read these in order:
1. `README.md` (especially "Build state" and "Still open") — what exists, what's planned
2. `ARCHITECTURE.md` §1, §2, §5 — tenancy model, lakehouse, RLS/embed pattern
3. `docs/architecture/tenant-variability.md` — why we hardcode per-fennec rules and when to refactor
4. `docs/architecture/rls.md` — per-user scope enforcement in the native query path
5. `docs/architecture/clerk-webhooks.md` — invite + provisioning flow
6. `docs/product/web-display-philosophy.md` — native-first rendering, PBI as escape hatch
7. `docs/product/goals.md`, `ai-layer.md`, `user-access.md` — deferred design sketches

## Open decisions
See README.md "Still open" section.
