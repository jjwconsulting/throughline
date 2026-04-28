# Matrix tables — design sketch

Status: **open**. Not built. This doc is the spike before any code.

## Why this surface

Pharma analytics in PBI lives in matrix tables. Fennec's killer surface is
"Ordering Account History" — accounts as rows, calendar months as columns,
units in cells, with heatmap shading by value. Same shape recurs across the
Fennec + TriSalus reports James worked on:

- Account × month × units (the screenshot example)
- HCP × month × calls
- Specialty × quarter × calls
- State × month × revenue
- Class of trade × quarter × NRx

Fennec implements this in Power BI with **field parameters** — three
slicers (Rows, Columns, Values) drive a single matrix visual. End users
don't write DAX; they pick from dropdowns and the matrix re-pivots.

Throughline's wedge: bring that same interaction into the native React
app, RLS-scoped, without forcing customers into Power BI. Plus we own
the URL state so dashboards become shareable / bookmarkable.

## Tractable scope (V1)

We have these dimensions that can serve as ROWS:

- **HCO** — `gold.dim_hco` (name, type, city, state, class of trade, etc.)
- **HCP** — `gold.dim_hcp` (name, specialty, tier, state)
- **Rep / User** — `gold.dim_user`
- **Territory** — `gold.dim_territory` (description as primary label)
- **Specialty** — derived from `dim_hcp.specialty_primary`
- **Class of trade** — derived from `dim_hco.hco_type` or similar
- **State** — derived from `dim_hcp.state` or `dim_hco.state`

These COLUMNS (time grain):

- **Week** (Monday-anchored)
- **Month** (calendar)
- **Quarter** (calendar)
- **Year**

These METRICS (values):

- Calls (count)
- Net units (signed sum from `fact_sale.signed_units`)
- Net dollars (signed sum from `fact_sale.signed_gross_dollars`)
- Distinct HCPs touched
- Distinct HCOs touched
- Goal attainment % (where applicable)

Out of scope V1 (deferred):

- Custom calculated columns
- Filtering on dimension values inside the matrix (e.g., "show only Tier 1")
  — covered by the existing FilterBar
- Drill-down (click a cell to see source rows)
- Export to Excel — easy add but defer
- Conditional cell formatting beyond simple heatmap

## Two implementation paths

### Path A: Pre-baked matrices (fast, opinionated)

Hand-build 3-5 specific matrix combinations as native React components,
each with its own loader function. Use cases pulled from Fennec's most
common reports:

1. **Account × Month × Net Units** (the screenshot exact match)
2. **HCP × Month × Calls** (rep operational view)
3. **Territory × Quarter × Net Units** (manager rollup)
4. **Specialty × Month × Calls** (medical / MSL view)
5. **State × Quarter × Net Units** (geographic exec view)

Each is an isolated `/explore/account-history`, `/explore/hcp-calls`, etc.
route. Filter bar on each. Reuses existing TrendChart-style data loaders
but reshapes output as `{rowKey, [bucket]: value, total}`.

**Pros:** ships in days each. Tested SQL per surface. Zero query-builder
abstraction needed. Follows the established pattern (each dashboard
section has its own loader + UI block). Customers see the named reports
they expect.

**Cons:** N matrices = N implementations. Doesn't generalize. A new
combination requires new code each time. Not the "PBI replacement" story.

### Path B: Generic matrix (powerful, abstract)

A single `/explore` route with three picker components (Rows / Columns /
Values) and a generic SQL builder that emits a pivoted query. Same
component renders any combination.

**Pros:** one surface to build, infinite combinations. The "PBI
replacement" story. Customer self-service.

**Cons:** ~weeks of work. Need:

- A registry mapping dimension picks to (table, key column, label
  column, JOIN path)
- A registry mapping metric picks to (fact table, value column, sign
  function)
- A SQL builder that composes a pivot query from the picks. T-SQL
  doesn't have great native PIVOT for dynamic columns — usually rolled
  with conditional aggregation:

```sql
SELECT
  <row_key> AS row_key,
  SUM(CASE WHEN bucket = '2026-01' THEN value END) AS bucket_2026_01,
  SUM(CASE WHEN bucket = '2026-02' THEN value END) AS bucket_2026_02,
  ...
FROM <fact_join>
GROUP BY <row_key>
ORDER BY <total or first column>
```

- Dynamic column generation in JS (which buckets to render, in what
  order)
- Header row + heatmap cell coloring (CSS-only, via quintile thresholds)
- URL state for the picker choices so views are shareable

### Recommended phasing

**Phase 1 (V1):** ship 1-2 pre-baked matrices on a `/explore/[matrix]`
route. Account × Month × Units is the obvious first since it mirrors
Fennec's killer surface and we already have all the data wired.

**Phase 2 (V1.5):** add 2-3 more pre-baked matrices using the same
component shell. By the third one we'll have factored out a reusable
`MatrixTable` component that takes `{rows, columnHeaders, cells, format,
heatmapBy}`.

**Phase 3 (V2):** generic picker UX on top of the same `MatrixTable`.
Build the row/column/value registries. Probably worth doing only after
the V1 matrices have validated which dimensions/metrics customers
actually use.

## UX sketch (Phase 1)

Route: `/explore/account-history` (or whatever names).

```
┌─ Account history — Net Units ────────────────────────────────────────────┐
│ FilterBar (range, granularity=month, channel, territory)                 │
│ Row scope: All HCOs ▼   |  Column grain: Month ▼  |  Metric: Net Units ▼ │
│                                                                          │
│ ┌────────────────────────────────────────────────────────────────────┐   │
│ │ Account              │ City    │ State│ Type    │ Jan │ Feb │ Mar │   │
│ ├────────────────────────────────────────────────────────────────────┤   │
│ │ City of Hope Duarte  │ Duarte  │ CA   │ Academic│ 40  │ 64  │ 33  │   │
│ │ Margaret Cochran VA  │ NY      │ NY   │ Gov     │     │ 12  │ 21  │   │
│ │ Childrens Wisconsin  │ Milwauk │ WI   │ Pediatric│ 18 │  5  │  5  │   │
│ │ ...                                                                │   │
│ └────────────────────────────────────────────────────────────────────┘   │
│                                                                          │
│ Heatmap: cell shading by quintile within column. Empty = no sales.       │
└──────────────────────────────────────────────────────────────────────────┘
```

Cell coloring: quintile-based amber gradient (0% → transparent;
100th-percentile-of-column → solid amber). Match Fennec's screenshot
visual style.

Sortable headers: clicking a column header sorts by that column DESC
(then ASC on second click). Total column sticky on right.

## Resolved decisions (for V1)

1. **Sort default**: Total DESC. "Biggest customers first" is the
   universal pharma framing — matches Fennec's screenshot and the
   account-motion tables we already ship.
2. **Heatmap scaling**: global. One min/max across all cells in the
   matrix so shading is comparable across rows AND columns. (Per-column
   quintiles can be added later as a toggle if customer feedback wants
   it; default to consistent.)
3. **Bucket count**: driven by FilterBar (range + granularity), capped
   at 24 to keep the table readable. Same `chartBuckets()` helper that
   trends use.
4. **Empty cells**: render blank. Cleaner read; the column header makes
   it obvious it's a data cell, not a missing one.
5. **First sale column**: opt-in via a toggle in the matrix header.
   Adds one MIN() aggregate so it's cheap when on.
6. **HCO scope**: only HCOs with non-zero net units in the displayed
   window. Faster, less noise. The "complete coverage" view is already
   answered by `/reps/[user_key]` Coverage HCOs and the account-motion
   surfaces — those are the right places to find HCOs with NO activity.

## Effort estimate

- **First pre-baked matrix** (Account × Month × Units): 1-2 days. SQL
  pivot, reusable `MatrixTable` component sketch, route + FilterBar
  wiring, heatmap CSS.
- **Each subsequent pre-baked matrix**: 0.5-1 day if `MatrixTable` is
  reusable.
- **Generic picker (Path B)**: 1-2 weeks. Registries, SQL builder,
  picker UX, URL state, shareable views.

## Why this is a good wedge

Fennec/TriSalus customers are paying for PBI today partly because
matrix tables aren't easy to roll yourself. If we ship 3-5 of the most
common matrix combinations natively, we cover 80% of "I need to look
at things in a grid" use cases without making customers context-switch
into PBI. That's a real differentiator vs the existing tools.

The PBI escape hatch (`/reports/[id]`) stays for the long tail —
custom matrix layouts, drill-throughs, complex calculated columns.
