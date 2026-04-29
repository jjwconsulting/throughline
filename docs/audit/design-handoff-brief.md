# Design handoff brief

**For:** designer / Claude Design.
**Companion docs:**
- `ui-patterns.md` — current visual system + interaction conventions
  (color tokens, typography, card/button/table/empty-state vocabulary).
  Read this first to understand the existing language.
- `site-audit-2026-04-29.md` — full engineering audit (deeper detail
  on data flow, lib organization, tests, etc.). Reference if needed
  for context on a specific surface; not required reading.

**Project:** Throughline — multi-tenant pharma commercial-analytics
SaaS. Light theme, warm-cream palette, two fonts (DM Serif Display
headers, DM Sans body). Reps, managers, admins. Built quickly through
a feature-breadth phase; engineering completed a cross-cutting
cleanup pass on 2026-04-29 and now wants design eyes on what's left.

**This is the handoff.** Engineering has been intentional about not
making visual decisions you should make. We're handing you a working
app with a clear visual baseline and asking for your opinion on
hierarchy, density, mobile, and component API.

---

## Already addressed (2026-04-29 cleanup pass)

So you know what NOT to redo:

- **Empty-state inconsistency** → standardized to italic muted-text
  pattern (`px-5 py-8 text-center text-sm text-ink-muted italic`)
  across all 16 surfaces. Documented in `ui-patterns.md`.
- **Account Motion consolidation on /dashboard** → 4 separate cards
  (Rising / Declining / Watch list / New) collapsed into one tabbed
  panel (`account-motion-panel.tsx`) with URL-driven tab state.
- **Snapshot card parity** → HcoSnapshotCard + RepSnapshotCard added
  matching the existing HcpSnapshotCard. All three detail pages now
  open with a consistent 4-stat snapshot grid.
- **Coverage HCOs long-list** on /reps/[user_key] → was a wall of
  200+ rows; now `coverage-hcos-table.tsx` with default-truncate
  (top 20 sorted Primary first) + client-side search bar +
  "Show all 187 →" toggle. Establishes a reusable long-list pattern
  documented in `ui-patterns.md`.
- **/settings hidden from nav** until it has real content.
- **/reports empty state** rewritten to user-friendly copy (no longer
  leaks env var name).
- **PowerBI deep link** moved from dashboard footer to subtitle row.
- **LLM surface boilerplate** unified — shared JSON parser + shared
  prompt preamble across 3 LLM surfaces (synopsis, recommendations,
  call brief).

---

## What we're asking from design

Six concrete deliverables, in priority order:

### 1. Page-level visual hierarchy critique

Two pages have density problems we couldn't resolve without your
opinion on how to GROUP and PRIORITIZE:

#### `/dashboard`
~10 vertical sections on a populated tenant. All cards use identical
visual weight. No grouping, no super-sections. The user gets a flat
scroll without an opinion on what matters most.

Sections in render order:
1. SynopsisCard (LLM, conditional)
2. AccountToggle + 4 KPI cards (Interactions, Reach, Active reps, Net units)
3. Calls trend chart
4. Net units trend chart
5. SignalsPanel ("HCPs to re-engage")
6. HCP tier coverage table (conditional)
7. Team rollup table (conditional, manager/admin)
8. Top reps + Top HCPs/HCOs (2-col grid of small tables)
9. Top HCOs by Units table (conditional)
10. Top reps by Units table (conditional)
11. AccountMotionPanel (newly consolidated tabs)
12. Top distributors (unmapped) table (conditional, admin)

**What we want from you:** how should these be grouped? Should there
be visual super-sections ("Today" / "This period" / "Trends" /
"Things to act on" / "Health of data")? Different card sizes for
different importance? Sidebar nav-within-dashboard? An opinion.

#### `/hcps/[hcp_key]`
7+ cards on a one-physician detail page. Recently densified by
adding Snapshot + SinceLastVisit + ScoreBreakdown + PeerCohort to
the original page (KPIs + Trend + Calling-reps). Result: three
different framings of "last call date" / "engagement" appear, two
different bar visual treatments coexist (per-scope score bars vs
peer cohort channel mix bars).

Sections in render order:
1. Header (name + subtitle + tier/flag badges + FilterBar)
2. **HcpSnapshotCard** (4 stats + action toolbar)
3. **SinceLastVisitCard** (recent activity diff)
4. KPI cards (3-col: Interactions, Reps engaged, Last contact)
5. **TargetScoreCard ("Score breakdown")** — per-scope bars + contributors
6. **PeerCohortCard ("Compared to similar HCPs")** — descriptive comparison
7. Calls trend chart
8. Reps who've called table

**What we want from you:** is the snapshot at top the right
treatment? Should the KPI cards collapse / merge into Snapshot now
that Snapshot owns the headline metrics? Should TargetScoreCard +
PeerCohortCard live behind expanders ("Show breakdown" / "Compare to
peers") since they're detail-not-overview?

### 2. KPI sub-line concatenation problem

The Interactions card on /dashboard now reads:
> 5,431
> Interactions (last 12 weeks)
> 98% of goal · -3% vs prior period · 4,732 live · 699 drop-off

That's three secondary signals concatenated into one tiny line. Same
problem on the Net units card (attainment + dollars + delta).

**Decide:** one priority signal per card with context-specific rules?
Multi-line treatment? Tooltip for secondary detail? A clean opinion.

### 3. System-level component spec

We want to extract a real component system (currently inline JSX
across ~40 sites). Need design specs for:

- **`<Card>` / `<CardHeader>` / `<CardBody>`** — slot API + variants.
  Currently every panel uses the same inline pattern (see
  `ui-patterns.md`). What variants do we need? Default, accented,
  collapsible, action-toolbar?
- **`<Button>`** — primary, secondary, ghost, destructive, with size
  variants (compact, default). Currently we have ad-hoc class strings
  duplicated across the app. The button TYPES we use today are listed
  in `ui-patterns.md`.
- **Typography hierarchy** — we have h1, h2, body, small. No h3
  distinction, which is part of why /dashboard reads flat. Do we need
  an h3 / super-section heading style?

For each: visual treatment + when to use which variant.

### 4. Engagement status visual standard

We added a "Hot / Active / Lapsed / Cold" engagement label across
three snapshot cards (HCP / HCO / Rep). It's currently rendered as
colored display-text:
- Hot → positive green
- Active → accent gold
- Lapsed → negative red
- Cold → ink-muted

**Verify:** is colored text the right treatment? Should it be a
badge with a background? Pill? Ring around a number? This is now in
3 places so the decision propagates.

### 5. Color usage audit (especially the warm gold accent)

The warm gold accent (`#C89B4A`) is currently used for:
- Tier badges (background)
- "Active" engagement state
- Mid-tier attainment (50-79%)
- Trend chart fills (default series color)

**Verify:** is it overloaded? Especially in proximity to the deep-green
primary in trend charts. Also check accessibility contrast on the
various surface colors.

### 6. Mobile / responsive direction

Tailwind grid classes suggest mobile-friendly intent
(`grid-cols-1 md:grid-cols-2 lg:grid-cols-4`), but:
- Wide tables (`/admin/mappings`, `/explore` matrix) will overflow.
  (Coverage HCOs is now compact via the long-list pattern.)
- Header rows with FilterBar use `flex-wrap` — should degrade but
  not verified
- Numeric columns + monospace fonts may look cramped at small sizes

**What we want from you:** target breakpoints (tablet — managers
between meetings — is more realistic than phone), what degrades
acceptably, what needs a different layout. We don't need full mobile
mocks, just direction.

---

## Smaller items

Items that are real but less load-bearing — happy to take your
opinion on these alongside the priorities above:

- **No global entity search.** Power users want a Cmd+K omnibox to
  jump to a known HCP / HCO / Rep. What's the IA — modal, inline,
  always-visible?
- **AccountMotionPanel tab styling.** First tabbed component in the
  app — sets a precedent for future tabs. Verify the current
  styling is right.
- **Two trend charts back-to-back** on /dashboard and /reps/[user_key]
  (Calls + Net units). Identical treatment, different metrics. Toggle
  switch? Side-by-side mini? Keep as-is?
- **Snapshot card consistency** — HCP / HCO / Rep snapshots all use
  the same 4-stat grid layout. Worth a design pass to make sure
  they're visually consistent and the stats land for each entity type.
- **Sales attribution table** on /hcos has admin-focused footer text
  always visible to all roles. Should it be a tooltip / "?" affordance
  for non-admin viewers?
- **Score breakdown bars vs Peer cohort channel mix bars** on /hcps.
  Two different visual treatments for similar concepts. Should they
  converge?
- **/admin/mappings density** — workflow-heavy admin page (CSV +
  pipeline trigger + unmapped table + saved mappings). Could be
  tabified. Is that the right move, or is the all-on-one-page
  density appropriate for an admin workflow?

---

## Visual system snapshot (also in `ui-patterns.md`)

### Color tokens

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

### Typography

- **DM Serif Display:** h1 (`text-3xl`), h2/card titles (`text-lg`),
  KPI big numbers (`text-3xl`), Snapshot stat values (`text-3xl`).
- **DM Sans:** all body text, labels.
- **System mono:** numeric table cells, IDs, timestamps.

**Gap:** no h3 distinction. Pages with many sections (dashboard) read
flat as a result. Open question for design.

### Card vocabulary (informally consistent across ~40 sites)

```
rounded-lg bg-surface border-border
  px-5 py-4 border-b border-border  ← header
    h2 font-display text-lg          ← title
    p text-xs ink-muted              ← subtitle
  <body>
```

Excellent consistency. We want to formalize this as a `<Card>` /
`<CardHeader>` / `<CardBody>` component once you've spec'd it.

### Empty state pattern (NEW: standardized 2026-04-29)

```tsx
// Inside table:
<tr>
  <td colSpan={N} className="px-5 py-8 text-center text-sm text-[var(--color-ink-muted)] italic">
    {explanatoryMessage}
  </td>
</tr>

// Standalone:
<div className="px-5 py-8 text-center text-sm text-[var(--color-ink-muted)] italic">
  {explanatoryMessage}
</div>
```

---

## Per-page render-order summary

For your reference. Detail in `site-audit-2026-04-29.md` §2.

| Page | Top-of-page | Mid | Bottom |
|---|---|---|---|
| `/dashboard` | Synopsis (LLM) → KPI grid | Trends + Signals | Top-tables + AccountMotion + Distributors |
| `/hcps/[hcp_key]` | Snapshot + SinceLastVisit | KPIs + ScoreBreakdown + PeerCohort | Trend + Reps-who-called |
| `/hcos/[hco_key]` | Snapshot | Trend + AffiliatedHCPs + Sales section | Attribution + Reps-who-called |
| `/reps/[user_key]` | Snapshot + Recommendations (LLM) | KPIs + Trends | Coverage + Signals + Top HCPs |
| `/explore` | Header + Pickers | MatrixTable | (single-purpose page) |
| `/inbox` | Header | Signals grouped by category | (single-purpose page) |
| `/ask` | Header | ChatThread | (single-purpose page) |
| `/admin/*` | Form | Existing data table | Footer notes |

---

## What's intentionally out of scope

- **Data accuracy / loader logic** (engineering)
- **LLM prompt content** (engineering / product)
- **Notebook-level data plane** (engineering)
- **Performance benchmarking** (engineering)
- **Authentication/Clerk flows** (engineering)
- **WCAG accessibility deep dive** (separate project; high-level
  callouts are fine)
- **Feature additions or removals** (product decisions)
- **i18n** (single-locale en-US for now)

---

## How to read the deliverables

For each numbered item in "What we're asking from design," structure
your response as:

1. **Diagnosis** — your read of what's actually wrong (one paragraph)
2. **Recommendation** — concrete proposed treatment (color, spacing,
   sizes — clear enough an engineer can implement)
3. **Tradeoffs / open questions** — what you'd want a real designer
   review or user research to validate

Then a **prioritized punch list** at the end synthesizing
everything into top-N actionable changes with impact + effort
estimates.

If it would help to do this iteratively (e.g. lock down hierarchy
first, then component spec, then mobile), tell us. Engineering can
ship in that order.
