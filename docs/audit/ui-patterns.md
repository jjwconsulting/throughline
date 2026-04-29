# UI patterns reference

Living style + interaction conventions for the web app. Update as
patterns formalize. Companion to `site-audit-2026-04-29.md`.

---

## Empty states

### Rule

**Structural panels** (orientation panels — KPI cards, page-level
trend charts, "Top X" tables on dashboard, "Reps who've called" on
detail pages) → **always render**, show inline empty state when no
data.

**Conditional panels** (only meaningful with data — Tier coverage,
Team rollup, Account motion lists, Top-by-units sales tables, Watch
list, Targeting score, Peer cohort) → **hide entirely** when empty.

If unsure: when the panel's question ("how am I doing on X?") is
relevant to every user regardless of data presence, treat as
structural. When the question only makes sense IF there's data
("which accounts are declining?"), treat as conditional.

### Visual standard

**Inside a table** (no rows):
```tsx
<tr>
  <td
    colSpan={NUMBER_OF_COLUMNS}
    className="px-5 py-8 text-center text-sm text-[var(--color-ink-muted)] italic"
  >
    {explanatoryMessage}
  </td>
</tr>
```

**Inside a card** (non-tabular content):
```tsx
<div className="px-5 py-8 text-center text-sm text-[var(--color-ink-muted)] italic">
  {explanatoryMessage}
</div>
```

For empty states with more breathing room (e.g. card-as-empty-state
where the empty IS the page state, not a sub-section):
```tsx
<div className="px-5 py-12 text-center text-sm text-[var(--color-ink-muted)] italic">
  {explanatoryMessage}
</div>
```

### Copy guidance

- **Be specific about why** the section is empty when possible:
  "No calls in this period." beats "No data."
- **Action when relevant:** "Add one above to declare a bronze
  column." after the empty state when the user can resolve it.
- **Italic by default** to visually differentiate from real content.
- **Inline code** (e.g. table names) inside the empty state should
  use `class="font-mono not-italic"` to override the italic.

### Examples

```tsx
// Structural panel — table with no rows
"No calls in this period."
"No HCP calls in this period."
"No HCO calls in this period."
"No matches in this period."

// Conditional panel that's been forced visible (rare)
"No declining accounts in this window."
"No rising accounts in this window."

// Card-as-empty-state (full panel scope)
"No mappings configured yet. Add one above to declare a bronze column."
"No pipeline runs recorded yet. Schedule pipelines in the Fabric workspace."
```

---

## Card pattern (informal but consistent)

Every panel uses:
```tsx
<div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
  <div className="px-5 py-4 border-b border-[var(--color-border)]">
    <h2 className="font-display text-lg">Title</h2>
    <p className="text-xs text-[var(--color-ink-muted)]">
      Subtitle / context
    </p>
  </div>
  {/* body */}
</div>
```

For cards with header actions (export button, link, etc.):
```tsx
<div className="px-5 py-4 border-b border-[var(--color-border)] flex items-baseline justify-between gap-4 flex-wrap">
  <div>
    <h2 className="font-display text-lg">Title</h2>
    <p className="text-xs text-[var(--color-ink-muted)]">Subtitle</p>
  </div>
  <ActionButton />
</div>
```

For full-bleed table cards: omit the body wrapper padding so the
table extends edge-to-edge.

For padded body cards: use `p-5`.

**Future:** extract a `<Card>` / `<CardHeader>` / `<CardBody>`
component once we're sure the pattern is stable. Currently inlined
across ~40 sites.

---

## Button variants

Currently used:

```tsx
// Primary action / link-out (e.g. "Open in Veeva")
className="inline-flex items-center gap-1.5 text-xs rounded-md px-3 py-1.5 bg-[var(--color-primary)] text-white hover:opacity-90"

// Secondary action / in-app trigger (e.g. "Generate call brief")
className="inline-flex items-center gap-1.5 text-xs rounded-md px-3 py-1.5 bg-[var(--color-surface)] text-[var(--color-ink)] border border-[var(--color-border)] hover:bg-[var(--color-surface-alt)] disabled:opacity-60"

// Submit (forms)
className="rounded-md bg-[var(--color-primary)] text-white text-sm px-4 py-2 hover:opacity-90 disabled:opacity-50"

// Inline link (table cell navigation)
className="text-[var(--color-primary)] hover:underline"

// Inline link (small / footer)
className="text-xs text-[var(--color-primary)] hover:underline"
```

**Future:** define these as `<Button variant="primary|secondary|submit">`
with `size="compact|default"` once design has reviewed.

---

## Color usage

| Token | Hex | Used for |
|---|---|---|
| `background` | `#FAFAF7` | Page background |
| `surface` | `#FFFFFF` | Card backgrounds |
| `surface-alt` | `#F3F2EE` | Hover states, secondary fills |
| `ink` | `#1C1B19` | Primary text |
| `ink-muted` | `#5A564E` | Secondary text, table defaults |
| `primary` | `#1F4E46` | Primary actions, links, brand |
| `accent` | `#C89B4A` | Mid-state metrics, tier badges |
| `positive` | `#3D8B5E` | Rising metrics, healthy attainment |
| `negative` | `#B24545` | Declining metrics, low attainment |
| `border` | `#E5E3DB` | All borders, table dividers |

**Conventions:**
- `positive` for rising/up/healthy/Hot/Live
- `negative` for declining/down/lapsed/never-called/dropoff (when emphasizing concern)
- `accent` for mid-state (Active engagement, mid-tier attainment)
- `ink-muted` for de-emphasized values (default table cell color)
- Never use color alone to convey meaning — always pair with
  text/icon for accessibility.

---

## Typography hierarchy

- `font-display text-3xl` — page title (h1)
- `font-display text-3xl` — KPI big number (visual parity with h1)
- `font-display text-lg` — section title (h2)
- `font-display text-xl` — Snapshot card stat values
- `text-base` — body default
- `text-sm` — body in dense contexts (KPI labels, table cells, etc.)
- `text-xs` — secondary text (subtitles, sub-lines, metadata)
- `text-[11px]` — fine print (caveat footers)
- `font-mono` — numeric table cells, IDs, timestamps, code refs

**Gap:** no h3 distinction. Pages with many sections (dashboard) read
flat as a result. Awaiting design review on whether to introduce a
super-section header.

---

## Header (page-level)

```tsx
<div className="flex items-end justify-between gap-4 flex-wrap">
  <div>
    <h1 className="font-display text-3xl">Page Title</h1>
    <p className="text-[var(--color-ink-muted)]">
      One-line context.{" "}
      {/* Optional inline action: */}
      <Link href="..." className="text-[var(--color-primary)] hover:underline">
        Action →
      </Link>
    </p>
  </div>
  <FilterBar filters={filters} territories={accessibleTerritories} />
</div>
```

For detail pages (e.g. `/hcps/[hcp_key]`):
- Add a back link above the title: `text-xs text-ink-muted hover:text-ink`
- Tier + flag badges below the subtitle

---

## Tier + flag badges

```tsx
// Tier badge (accented background)
<span className="text-xs rounded px-2 py-0.5 bg-[var(--color-accent)]/15 text-[var(--color-ink)]">
  Tier 1
</span>

// Status flag badge (subtle bordered)
<span className="text-xs rounded px-2 py-0.5 bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)] border border-[var(--color-border)]">
  KOL
</span>

// Status flag — positive
<span className="text-xs rounded px-2 py-0.5 bg-[var(--color-positive)]/15 text-[var(--color-positive)]">
  Primary
</span>

// Status flag — negative
<span className="text-xs rounded px-2 py-0.5 bg-[var(--color-negative)]/15 text-[var(--color-negative)]">
  High
</span>
```

---

## Long lists (default-truncate + search + show-all)

Pattern for any panel where the data set can grow beyond ~30 rows
and reps would scroll past 90% of it looking for a specific entity.
First implemented in `components/coverage-hcos-table.tsx` for the
Coverage HCOs section on `/reps/[user_key]`.

Three pieces:

1. **Card header** — title, descriptive subtitle, search input on
   the right with an inline "Clear" button when search is active.
   ```tsx
   <input
     type="search"
     placeholder="Search name, type, location…"
     className="text-sm rounded-md border border-[var(--color-border)]
                bg-[var(--color-surface)] text-[var(--color-ink)]
                px-3 py-1.5 w-56 focus:outline-none focus:ring-2
                focus:ring-[var(--color-primary)]"
   />
   ```
2. **Result count line** — a thin bar between header and body that
   adapts to context: "Showing 20 of 187 (sorted X first)" /
   "47 matches for 'oncology'" / "No matches for 'foo'." Includes a
   "Show all 187 →" toggle when truncated.
   ```tsx
   <div className="px-5 py-2 border-b border-[var(--color-border)]
                   bg-[var(--color-surface-alt)]/30 text-xs
                   text-[var(--color-ink-muted)] flex items-baseline
                   justify-between gap-4">
     ...
   </div>
   ```
3. **Default truncation** — show top N (typically 20) sorted by the
   most useful default. When user types in search, show ALL matches
   (not just the first 20), so rows below the truncation surface.

**When to use:** any list where the user is more likely to be
hunting for a specific entity than scanning the full set. Coverage
HCOs (200+), saved mappings (100+), affiliated HCPs at large
hospitals (varies).

**When NOT to use:** "Top X" tables that always show a fixed top-N
ranking — those are intentionally short and ranking is the point.

**Server-side vs client-side filtering:** client-side is fine when
the full set fits comfortably in JSON (~50KB / ~500 rows). Beyond
that, switch to server-side filter via debounced search + URL state.

## Tables

```tsx
<table className="w-full text-sm">
  <thead className="text-xs text-[var(--color-ink-muted)]">
    <tr>
      <th className="text-left font-normal px-5 py-2 w-8">#</th>
      <th className="text-left font-normal px-5 py-2">Label</th>
      <th className="text-right font-normal px-5 py-2">Numeric</th>
    </tr>
  </thead>
  <tbody>
    {/* either rows or empty-state row */}
    {rows.map(...)}
  </tbody>
</table>
```

- Numeric columns: `text-right font-mono`
- Hover: `hover:bg-[var(--color-surface-alt)]`
- Row dividers: `border-t border-[var(--color-border)]` on each row
- Rank/index column: `w-8` width, ink-muted color
- Linked names: use `text-[var(--color-primary)] hover:underline`

---

## Last updated

2026-04-29 — initial extraction during the post-buildout audit pass.
Add new patterns here as they formalize across the codebase.
