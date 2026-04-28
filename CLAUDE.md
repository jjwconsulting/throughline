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

**See README.md "Build state" section** for specifics + the immediate-next-milestone (currently: tenant-custom HCP/HCO scoring attributes — third-party Komodo/Clarivate/IQVIA data spec at `docs/architecture/tenant-custom-attributes.md`).

## Architectural patterns we settled on
- **Postgres = canonical for admin-edited state** (goals, mappings, tenant_user, tenant config, pipeline_run). Web app interactive reads go to Postgres.
- **Fabric = downstream analytics mirror** (config_sync, goals_sync, etc.). PBI / SQL JOINs / scheduled analytics use these. Sync-lagged; never read for fresh-write displays.
- **Bronze CSV import + UI per-row** is the pattern for both goals AND mappings. Bulk for day-1 setup, UI for ongoing.
- **Recommendation-driven defaults** (goals form pre-fills with statistical recommendations + LLM rationale on demand). The 80/20 framing — auto-recommend the 80%, easy tweak for the 20% with conviction.
- **Signed measures** in fact tables for net-math (`-ABS()` on RETURNS so source convention doesn't matter).
- **Sales attribution: single-credit, multi-visibility (Option B hybrid).** One territory per HCO is `is_primary` for sales credit (preserves tenant-total reconciliation). All assigned territories show in rep coverage views (matches Fennec's day-to-day rep experience). Primary-pick: `has-rep first` (avoids dead-end attribution when a top-team-role territory has no rep), then `SAM > KAD > ALL > MSL`, then manual > rule, then alpha.
- **Sales metric default = UNITS, not dollars.** Pharma reps think in units (vials/doses/cycles); dollars are finance/exec context. KPI cards lead with units + dollars sub-line. Tables sort by units.
- **Sales goals at TERRITORY entity, calls goals at REP entity.** Pharma standard — territories are stable units of market potential; reps come/go but the goal stays. Rep "effective goal" = sum of territories where they're current rep.
- **Unmapped + unattributed sales must always be visible.** Aggregate SUMs include them; breakdowns surface as "Unmapped" / "Unattributed" pseudo-rows. Never silently drop fact_sale rows. (See `project_unmapped_sales_visibility` memory.)
- **Per-tenant rules as hardcoded notebook constants** today (TEAM_ROLE_RULES, ELIGIBLE_REP_TYPES). Tracked debt; refactor to per-tenant config table when tenant #2 lands.
- **LLM is a narrator, never a knowledge source.** Every LLM-driven surface (synopsis, rec card, /ask) gets structured input from existing loaders + narrates over it. Never invents — if data isn't in the input, it doesn't appear in the output. Each call cached per (entity × pipeline_run) with 4h rate-limit so repeat page loads + frequent prod refreshes don't burn LLM cost. See `project_llm_input_extensibility` + `docs/product/llm-expansion.md`.
- **Tool-use chat pattern (`/ask`):** lookup tools (`lookup_entity`, `lookup_territory`) resolve names → keys, then data tools take keys. Multi-step LLM calls compose. Tool calls visible in UI as collapsed pills for trust/auditability. Tenant + role isolation enforced at LOADER layer (belt + suspenders — never trust the LLM with scope).
- **Return raw shape, let the LLM filter** when tenant data formats vary (e.g., tier values are "1" vs "Tier 1" vs "T1" depending on Veeva picklist). Tools return all rows; LLM picks the relevant ones from inspection rather than hard-coded format guesses in the tool.
- **Veeva is the source of truth for calls** — never build parallel UI state-tracking that could diverge. Reps log activity in Veeva → our incremental sync picks it up. UI action buttons help reps EXECUTE on suggestions (open Veeva, generate prep brief), not check off completed items. See `project_rep_action_paradigm` memory.
- **Client component import gotcha:** if a client component (`"use client"`) imports from a `lib/*.ts` file that ALSO contains server-only helpers (anything using `mssql`/`tedious`/`queryFabric`, or anything that pulls in Node-only modules like `dgram`), Next.js bundles ALL of that file into the browser bundle and the build fails. Fix: split pure helpers (used by both server + client) into their own file, OR inline the helper into the client component. Comment in `lib/bronze-introspection.ts` flags the pattern.

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
