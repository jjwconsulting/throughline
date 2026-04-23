# Web display philosophy

## The default

**Render natively in the web app, not in embedded Power BI iframes.**

Most of what users see in throughline — dashboard summaries, list views,
KPI cards, drill-down detail pages — should be React components fetching
data from gold tables. Cohesive look, fast loads, branded, mobile-friendly,
clickable, integrated with the rest of the app's UX.

PBI embed is reserved for specific surfaces where it earns its keep
(see "When PBI embed is the right choice" below).

## Why this matters

Embedding PBI iframes everywhere makes the product feel like "a wrapper
around Power BI" instead of "a SaaS product that happens to use Power BI
underneath." The difference shows up in:

- **Brand & polish.** Native components match throughline's design system;
  PBI iframes look like Microsoft.
- **Page load.** PBI iframes carry their own bootstrap (~2-5s) on every
  page. Native components render in <500ms.
- **Mobile.** PBI embed's mobile UX is rough. Native React is whatever we
  build it to be.
- **Composition.** Want a card next to a list next to a chart, all
  filterable together? Trivial in React. Awkward in a single PBI canvas.
- **Click-through and routing.** Native components can deep-link into
  other product pages (`/hcp/<id>`, `/territory/<code>/calls`). PBI embed
  can't talk to the host app cleanly.
- **Per-customer customization.** Native components can pivot per tenant
  feature flag. PBI report customization means cloning reports per tenant.

## When PBI embed IS the right choice

Reserve it for:

- **Self-service report authoring.** When a customer's analyst wants to
  drag fields, build their own pivot, save a custom view. PBI's authoring
  UX is hard to beat. Surface as `/reports/explorer` or similar.
- **Heavy DAX measure-driven cross-tabs.** Multi-level matrix visuals,
  decomposition trees, what-if parameters — PBI handles these well and
  reimplementing them in React is months of work.
- **"View full report" detail pages** off contextual native widgets. A
  native KPI card might link to "Open full report" that loads a PBI embed
  with the relevant filters pre-applied.

If a surface doesn't have one of those reasons, build it native.

## Architecture: how native components get gold data

Three options for the web → Fabric query path:

| Path | How | Latency | When to use |
|---|---|---|---|
| **Fabric SQL endpoint** | `mssql` driver → SQL against `gold.*` | 1-5s (Spark cold-start, then warm) | Default for v1. No extra infra. Real-time. |
| **Fabric XMLA endpoint** | DAX queries via PBI REST API | 1-3s | When we want measure-aware queries that respect the semantic model |
| **Postgres mirror** | Schedule sync `gold.*` → Postgres, web queries Postgres | <100ms | When a page needs sub-second responses (top-of-funnel KPIs, frequent navigation) |

### MVP: Fabric SQL endpoint

For v1, query Fabric directly via the SQL endpoint:

- **Driver.** `mssql` Node.js driver (Microsoft's official). Connects to
  Fabric's auto-generated SQL endpoint on each lakehouse.
- **Auth.** Same service principal as PBI embed
  (`POWERBI_CLIENT_ID` / `POWERBI_CLIENT_SECRET`). Acquire AAD token,
  pass as bearer.
- **RLS.** **Enforced server-side in every query.** Web app looks up the
  signed-in user's `tenant_id` from Postgres `tenant_user` (existing
  pattern from the dashboard) and includes `WHERE tenant_id = @tenantId`
  in every SQL statement. *No exceptions* — RLS at the application layer
  is mandatory for native queries since we lose the PBI semantic model's
  RLS layer.
- **Query helper.** A typed wrapper similar to `lib/db.ts` for Postgres,
  but for the Fabric SQL endpoint. Auto-injects `WHERE tenant_id = ?`
  via a server-side query builder. Direct raw SQL discouraged at the
  call site.

### Promote to Postgres mirror when needed

When a specific surface starts loading slowly because of Spark cold-start,
add a sync job that materializes the relevant gold tables into Postgres
(same pattern as `config_sync` for config tables). Web queries the local
Postgres mirror; latency drops to <100ms.

Don't pre-build the mirror. Cost it when a real surface complains.

## Chart / visual component library

Defer the final choice until we have a real surface to build. Options on
the table:

- **[Tremor](https://www.tremor.so/)** — pre-built dashboard components
  (KPI cards, area charts, bar lists, donut). Fastest to ship a polished
  dashboard. Tailwind-native. Good fit for our stack.
- **[shadcn/ui charts](https://ui.shadcn.com/charts)** — Recharts wrapped
  in shadcn aesthetic. More flexible composition, matches whatever theme
  we land on.
- **Recharts directly** — most control, most code per visual.
- **ECharts / Apache Echarts** — most powerful but steeper learning
  curve; useful when we get to complex visuals (sankey, geo).

**MVP recommendation: Tremor** for speed. Migrate to shadcn or Recharts
if we hit a customization wall.

## Migration plan: current `/dashboard`

Currently `apps/web/app/(app)/dashboard/page.tsx` renders:
- 3 placeholder stat cards (no data)
- A PBI embed iframe

Migration target:

```
/dashboard
├── 4-6 native KPI cards (calls today, MTD, top rep, top specialty, etc.)
├── Native trend chart (calls over time, by quarter)
├── Native top-N tables (top 10 reps, top 10 HCPs, top specialties)
└── "View full report" link → /reports/<id> (PBI embed for deep dive)
```

Implementation order:
1. Set up Fabric SQL endpoint connection helper in `apps/web/lib/fabric.ts`
2. Add Tremor (or chosen lib) dependency
3. Build server-component KPI cards backed by single-row gold queries
4. Build trend chart from `gold.fact_call` joined to `gold.dim_date`
5. Build top-N tables from `gold.fact_call` joined to dims
6. Move PBI embed to `/reports/<report_id>` page
7. Replace dashboard's PBI iframe with native composition

## Anti-patterns to avoid

- **Embedding multiple small PBI visuals on the same page.** Each iframe
  pays bootstrap cost. Either go all-native or all-embed for a given page.
- **Using PBI embed for a single number / KPI.** Always faster and nicer
  as a native card.
- **Bypassing the RLS query helper.** Every native gold query MUST scope
  by tenant_id. No shortcuts even for "internal" or "admin" pages.
- **Pre-aggregating in the web layer.** If you find yourself summing
  10k rows in JavaScript, the query is wrong — push the aggregation to
  Spark / SQL.

## Trigger for revisiting this doc

- First customer demo where someone says "this looks like Power BI" —
  validates the philosophy
- A surface where Spark cold-start makes the page feel broken —
  triggers the Postgres mirror path
- Tenant #2 with a wildly different visual preference — could reopen
  the BI-stack discussion

For now: build native, embed selectively, ship it.
