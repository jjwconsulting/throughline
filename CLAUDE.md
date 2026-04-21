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
- **Do not** build custom charts — Power BI embed is the display default.
- **Do** require a `tenant_id` on every Fabric table schema from the first migration.
- **Do** write tests before porting a fennec notebook — fennec has zero test coverage and that's not surviving into SaaS.

## Current status (2026-04-20)
Baseline skeleton just scaffolded. No infra provisioned, no Fabric workspace, no Postgres, no Clerk/Stripe keys. `pnpm install && pnpm dev` should boot the web app with a placeholder marketing page + dashboard shell.

## Open decisions
See README.md "Still open" section.
