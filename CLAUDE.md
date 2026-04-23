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

## Current status (2026-04-23)
Everything from bronze through gold is built and tested against fennec's live Veeva data. 22,814 real calls flow through to `gold.fact_call`, joinable to `dim_hcp`/`dim_user`/`dim_date`. Direct Lake semantic model `throughline_direct_lake` contains all four dims plus fact_call with proper RLS roles.

**See README.md "Build state" section** for specifics on what's working end-to-end, what's not yet wired, and the immediate next milestone.

## Orientation for new sessions
Read these in order:
1. `README.md` (especially "Build state" and "Still open") — what exists, what's planned
2. `ARCHITECTURE.md` §1, §2, §5 — tenancy model, lakehouse, RLS/embed pattern
3. `docs/architecture/tenant-variability.md` — why we hardcode per-fennec rules and when to refactor
4. `docs/product/web-display-philosophy.md` — native-first rendering, PBI as escape hatch
5. `docs/product/goals.md`, `ai-layer.md`, `user-access.md` — deferred design sketches

## Open decisions
See README.md "Still open" section.
