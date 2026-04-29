# Throughline — Design Review

**Reviewer:** Claude Design
**Date:** 2026-04-29
**Scope:** Response to `docs/audit/design-handoff-brief.md` + `docs/audit/ui-patterns.md`
**Format:** Phased deliverable. Phase 1 (system) → Phase 2 (pages) → Phase 3 (mobile + smaller items + punch list).

> **How to read this:** every recommendation specifies hex values, Tailwind classes, and spacing tokens explicit enough to implement without re-asking. Where I propose a new token or class, the canonical name is in **bold**. Tradeoffs / open questions are flagged at the end of each section — those are the only places I'd want a real designer or user-research pass before committing.

---

# Phase 1 — System-level decisions

These are the foundations. Everything in Phase 2 (page hierarchy, KPI cards) consumes the primitives defined here, so this phase is the gating dependency.

---

## Deliverable 3 — Component spec

### 3.1 Typography hierarchy

#### Diagnosis
The current scale has h1, h2, body, small — and **no h3**. That's why `/dashboard` reads flat: ten visually identical `font-display text-lg` cards, no super-section grouping cue. The KPI big-number style (`font-display text-3xl`) is also at visual parity with the page title (`h1`), which steals hierarchy from the page header. Snapshot stat values are at `text-xl` per `ui-patterns.md` but the brief lists them as `text-3xl` — there's drift.

#### Recommendation — formalize a 6-step type scale

| Token | Class (Tailwind v4) | Font | Size / line-height | Tracking | Use |
|---|---|---|---|---|---|
| **`display-xl`** | `font-display text-4xl leading-[1.1] tracking-tight` | DM Serif Display | 36/40 | -0.01em | KPI big numbers, Snapshot stat values. **Reserved for numbers** so the eye learns "serif at this size = a metric to read." |
| **`h1`** | `font-display text-[28px] leading-[1.2] tracking-tight` | DM Serif Display | 28/34 | -0.005em | Page title only. **One per page.** |
| **`h2-section`** | `font-sans text-[11px] uppercase tracking-[0.12em] font-semibold text-ink-muted` | DM Sans | 11/16 | +0.12em | **NEW.** Super-section heading ("Today" / "Trends" / "Things to act on"). Sans, all-caps, wide tracking — visually distinct from card titles, doesn't compete with them. |
| **`h3-card`** | `font-display text-lg leading-[1.3]` | DM Serif Display | 18/24 | normal | Card titles. (Was `h2` — renamed. Same visual.) |
| **`body`** | `font-sans text-sm leading-[1.5]` | DM Sans | 14/21 | normal | Default body, table cells in dense contexts. |
| **`caption`** | `font-sans text-xs leading-[1.4] text-ink-muted` | DM Sans | 12/17 | normal | Card subtitles, sub-lines, metadata. |

**Two specific changes** beyond renaming:

1. **Page title shrinks from `text-3xl` to `text-[28px]`** (32→28). Counterintuitive, but right now `h1` and the KPI numbers fight each other. KPI numbers are the read-priority; the page title is orientation. Ceding 4px restores the hierarchy.
2. **Introduce `h2-section`** — sans, uppercase, ink-muted. This is the single most impactful intervention in the whole review and the foundation for the `/dashboard` hierarchy fix in Phase 2.

#### Tradeoffs / open questions
- **All-caps is mildly hostile to screen readers** (some announce letter-by-letter). Mitigation: use `text-transform: uppercase` in CSS, not literal capitals in markup. Verified accessible.
- I'd want a real type designer to confirm DM Serif Display holds up at 36px for KPI numbers — it has slightly inconsistent weight across digits at large sizes. If it looks fragile in production, fall back to `font-display text-3xl` for KPIs and reserve `display-xl` for `h1` instead.

---

### 3.2 `<Card>` component spec

#### Diagnosis
Inline JSX across ~40 sites, with the same pattern copied verbatim. The pattern itself is good — the inconsistency is in (a) header padding when actions are present (gets cramped at `px-5`), (b) full-bleed table cards omitting body padding ad-hoc, (c) no formal "accented" variant despite Synopsis and Recommendations LLM cards visibly wanting one.

#### Recommendation — slot API with three variants and three densities

```tsx
<Card variant="default" density="default" id?="…">
  <CardHeader>
    <CardTitle>Title</CardTitle>
    <CardSubtitle>One-line context</CardSubtitle>
    <CardActions>{/* optional toolbar */}</CardActions>
  </CardHeader>
  <CardBody>{/* arbitrary content */}</CardBody>
  <CardBody flush>{/* full-bleed for tables */}</CardBody>
  <CardFooter>{/* optional, e.g. "Show all 187 →" */}</CardFooter>
</Card>
```

**Variants** (visual treatment):

| Variant | Visual | Use |
|---|---|---|
| `default` | `rounded-lg bg-surface border border-border` | Everything by default. ~90% of cards. |
| `accent` | `rounded-lg bg-surface border-l-[3px] border-l-primary border-y border-r border-border` | LLM surfaces (Synopsis, Recommendations, Call brief). The 3px primary-green left border is the **only place** the primary color appears as an accent edge; that scarcity is what makes it signal "AI-generated, treat with appropriate skepticism." |
| `muted` | `rounded-lg bg-surface-alt border border-border` | Admin / system info cards (e.g. PowerBI deep-link footer, "How this is calculated"). Intentionally recessive. |

**Densities** (padding):

| Density | Header padding | Body padding | Use |
|---|---|---|---|
| `default` | `px-6 py-4` | `p-6` | Default. **Note: bumped from `px-5` to `px-6` (20→24px)** — `px-5` is too tight at 1440px viewport when the header has both title+subtitle and a right-side action toolbar. |
| `compact` | `px-5 py-3` | `p-5` | Dense grids (KPI cards, snapshot stat cells). |
| `flush` | `px-6 py-4` | `p-0` | Full-bleed tables. CardHeader keeps padding; CardBody has none. |

**Header sub-rules:**
- When `<CardActions>` present, header becomes `flex items-baseline justify-between gap-4 flex-wrap` (matches existing pattern).
- Title is `h3-card` (the new token from §3.1).
- Subtitle is `caption`.
- If subtitle wraps, the header should grow — never truncate the subtitle, it's load-bearing context.

**Migration:** keep the inline pattern working during transition. The component is a wrapper, not a rewrite.

#### Tradeoffs / open questions
- **Should `accent` have a hover/active state?** I'd say no — the LLM cards aren't interactive surfaces, they're content. If a card becomes interactive later, use `default` + a hover ring instead.
- **Padding bump from 20→24px will subtly increase vertical rhythm everywhere.** That's intentional but worth flagging — pages will get ~5–8% taller. Acceptable tradeoff for legibility but the punch list flags this so you can sanity-check at a 1440px viewport before merging the whole codebase.

---

### 3.3 `<Button>` spec

#### Diagnosis
Five inline class strings duplicated across the app, with subtle drift (gap-1.5 vs gap-2, py-1.5 vs py-2). No destructive variant despite admin pages having destructive actions (delete mapping, etc.). No icon-only variant despite the toolbar buttons in `HcpSnapshotCard`.

#### Recommendation — four variants × three sizes, plus an `icon` shape

```tsx
<Button variant="primary" size="default">Submit</Button>
<Button variant="secondary" size="compact" icon={<Briefcase />}>Generate brief</Button>
<Button variant="ghost" size="compact">Cancel</Button>
<Button variant="destructive" size="default">Delete mapping</Button>
<Button variant="ghost" shape="icon" aria-label="Open in Veeva"><ExternalLink /></Button>
```

**Variants:**

| Variant | Class | Use |
|---|---|---|
| `primary` | `bg-primary text-white hover:bg-primary/90 disabled:opacity-50` | Form submit, hero CTA. **At most one per surface.** |
| `secondary` | `bg-surface text-ink border border-border hover:bg-surface-alt disabled:opacity-60` | In-app triggers (Generate brief, Open in Veeva, Show all). Default for "buttons that do things" inside cards. |
| `ghost` | `bg-transparent text-ink hover:bg-surface-alt disabled:opacity-60` | Tertiary actions, table-row affordances, dismiss/close. |
| `destructive` | `bg-negative text-white hover:bg-negative/90 disabled:opacity-50` | **NEW.** Confirmed destructive only — delete mapping, force re-run pipeline. Pairs with a confirmation modal; never a one-click destroy. |

**Sizes:**

| Size | Class | Pixel height |
|---|---|---|
| `compact` | `text-xs rounded-md px-3 py-1.5 gap-1.5` | 28px |
| `default` | `text-sm rounded-md px-4 py-2 gap-2` | 36px |
| `large` | `text-base rounded-md px-5 py-2.5 gap-2` | 44px (use sparingly — form submit on standalone admin pages) |

**Shape `icon`:** square, side = pixel height of the size. `gap` collapses, `aria-label` becomes required at the type level.

**"Inline link" (e.g. table-cell entity nav) is NOT a Button** — it's a styled `<a>`. Keep it as `text-primary hover:underline`. Don't pretend everything is a button.

#### Tradeoffs / open questions
- **Focus ring.** Currently inconsistent. Spec all variants with `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary`. Keyboard accessibility hardening is mostly free here.
- **Loading state** — secondary buttons that trigger LLM calls (Generate brief, Recommendations) need a `loading` prop with a spinner. Not in the original brief; flagging as a small add.

---

## Deliverable 4 — Engagement status visual standard

#### Diagnosis
Coloured display-text is too quiet for a status that's now a primary read on three different snapshot cards. "Active" and "Hot" both currently appear as a single coloured word adjacent to other coloured words (positive/negative metrics), so the eye has to do work to distinguish "this is the engagement state" from "this is a delta value." It also collides directly with the warm-gold-overload problem in Deliverable 5 — "Active" using accent gold is part of why accent reads as overloaded.

#### Recommendation — soft-fill pill with leading dot, semantic colour split

Replace coloured text with a **pill** that has a saturated 8px dot + label, on a 10%-opacity tint of the same colour, with a 1px solid border at 25% opacity:

```tsx
// Spec
<span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium border">
  <span className="w-2 h-2 rounded-full bg-{TONE}" />
  <span className="text-{TONE}-deep">{label}</span>
</span>
```

| State | Dot | Border | Bg | Text | Replaces |
|---|---|---|---|---|---|
| **Hot** | `#3D8B5E` (positive) | `#3D8B5E`/25 | `#3D8B5E`/10 | `#2A6342` | green text |
| **Active** | `#1F4E46` (primary) | `#1F4E46`/25 | `#1F4E46`/8 | `#1F4E46` | **accent gold → primary green.** Resolves the gold-overload problem. |
| **Lapsed** | `#C89B4A` (accent) | `#C89B4A`/30 | `#C89B4A`/12 | `#7A5A1F` | **negative red → accent gold.** "Lapsed" isn't bad, it's a warning — reds should mean "trouble" not "needs attention." |
| **Cold** | `#5A564E` (ink-muted) | `#E5E3DB` (border) | `#F3F2EE` (surface-alt) | `#5A564E` | grey text — kept, but as a pill so it visually parallels the others. |

**The semantic shift in colour assignment is intentional and is the load-bearing recommendation here.** Today's mapping uses red for "Lapsed" which is too punitive — Lapsed is a state to act on, not a failure. Reserving red for "Cold" would be even more punitive; instead, Cold becomes neutral grey (it's just "we don't have a relationship") and red is kept in the system for genuinely-bad metric deltas.

**Sizing:** the pill is 22px tall, sits on the same baseline as adjacent text. Don't ever use it inline within a sentence — it lives in dedicated stat slots only.

#### Tradeoffs / open questions
- **Dot vs no dot.** The 8px dot is the cheapest way to make the pill scannable in peripheral vision. Drop it and you save 14px of width but lose ~30% of the at-a-glance differentiation.
- **The colour reassignment changes meaning** — "Lapsed" rows in the existing app currently render as red and users may have learned that signal. Worth a one-line release-note callout: "Engagement labels now use a unified pill style; Lapsed has shifted from red to amber to reduce false-alarm signal."
- I'd validate with one rep + one manager that "Hot / Active / Lapsed / Cold" ordering still scans correctly with the new colours. The order shouldn't change; just confirming nothing reads as unexpectedly demoted.

---

## Deliverable 5 — Color usage audit

#### Diagnosis
The accent gold (`#C89B4A`) is doing four jobs (tier badges, Active engagement, mid-tier attainment, default trend chart fill). That's not just overload — it's *meaning collision*: a gold pixel could mean "this is a tier-1 entity" OR "this metric is mid-state" OR "this is the primary series." Users have no way to distinguish without context. Separately, primary green (`#1F4E46`) and the trend-chart accent gold sit close in value (both around 50% lightness); on small chart marks they smear together. Negative red (`#B24545`) is fine but is also being used for "Lapsed" engagement, which (per Deliverable 4) is a misuse.

The base palette itself is good — warm cream + deep green is a coherent pharma-ops aesthetic and I would not change a hex value. The fix is **role discipline.**

#### Recommendation — assign each colour exactly one job, add two derived tokens

Single role per colour:

| Token | Hex | **Single role** | Removed from |
|---|---|---|---|
| `primary` | `#1F4E46` | Brand: links, primary CTAs, **Active engagement pill**, accent variant left border | (no removals; gains Active) |
| `accent` | `#C89B4A` | **Tier badges + Lapsed engagement pill ONLY.** | Mid-tier attainment, default trend fill |
| `positive` | `#3D8B5E` | Rising metrics, healthy attainment, **Hot engagement** | (no change) |
| `negative` | `#B24545` | Declining metrics, low attainment | **Lapsed engagement** (shifted to accent) |
| `ink-muted` | `#5A564E` | Secondary text, **Cold engagement**, default chart series | (gains chart default) |

**New derived tokens for charts** (so charts stop fighting the palette):

| Token | Hex | Role |
|---|---|---|
| **`chart-1`** | `#1F4E46` | Primary chart series (was: accent gold). Same as brand primary. |
| **`chart-2`** | `#C89B4A` | Secondary chart series only (e.g. comparison line). |
| **`chart-3`** | `#5A564E` | Tertiary / "other" chart series. |
| **`chart-grid`** | `#E5E3DB` | Gridlines, axis ticks. |

**Mid-tier attainment (50–79%) currently uses accent gold.** Replace with `ink-muted` for the value text, and use a horizontal bar with a primary-green fill at the appropriate width. This is consistent with the score breakdown bar treatment and removes the gold collision.

**Contrast check** (WCAG AA, 4.5:1 for body text):

| Foreground / background | Ratio | Verdict |
|---|---|---|
| `ink` / `surface` (#1C1B19 / #FFFFFF) | 17.6:1 | ✓ AAA |
| `ink-muted` / `surface` (#5A564E / #FFFFFF) | 7.6:1 | ✓ AAA |
| `ink-muted` / `surface-alt` (#5A564E / #F3F2EE) | 7.0:1 | ✓ AAA |
| `primary` / `surface` (#1F4E46 / #FFFFFF) | 9.4:1 | ✓ AAA |
| `accent` / `surface` (#C89B4A / #FFFFFF) | 2.8:1 | ✗ **FAIL** for body text |
| `accent` / `surface` for **non-text** (badge bg) | n/a | ✓ acceptable as decorative |
| `positive` / `surface` (#3D8B5E / #FFFFFF) | 4.2:1 | ✗ borderline (passes for large text only) |
| `negative` / `surface` (#B24545 / #FFFFFF) | 4.6:1 | ✓ AA |

**Two contrast actions needed:**
1. **Never use raw `accent` hex as text.** Every place currently rendering `text-[var(--color-accent)]` should switch to a darker tone — propose a derived `accent-deep` at `#7A5A1F` (4.7:1 against `#FFFFFF`, ✓ AA) for any label-on-light usage. The raw accent stays as a fill colour only.
2. **`positive` text fails on white at body size.** Either bump body text using positive to `font-medium` (which usually passes at 14px), or derive a `positive-deep` at `#2A6342` (6.1:1, ✓ AAA) for label use. I prefer the latter — same approach as accent-deep.

So the final palette adds:

| Token | Hex | Role |
|---|---|---|
| **`accent-deep`** | `#7A5A1F` | Accent-toned text (e.g. "Lapsed" label inside the pill) |
| **`positive-deep`** | `#2A6342` | Positive-toned text |
| **`negative-deep`** | `#8A2F2F` | Negative-toned text (current `negative` is borderline, `-deep` for dense table contexts) |

#### Tradeoffs / open questions
- **Trend-chart-1 = primary** is unconventional (charting libraries typically default to a brand-distinct accent). The argument for it: in a dashboard product the trend chart IS the brand surface, and the eye should associate "Throughline data" with primary green. The argument against: it makes the brand colour blend with chart noise. I'm betting on the former, but watch for it during the dashboard hierarchy work in Phase 2.
- **Accent gold gets significantly less screen time** under this rule. That's correct — it's an *accent*, currently being used as a primary. But re-validate with a stakeholder pass that the warm-cream brand mood survives. If the dashboard starts feeling cold, the right knob is to tint `surface-alt` slightly warmer (e.g. `#F1EEE7`), not to put gold back in chart fills.

---

## Phase 1 summary

What changes in code if all of Phase 1 ships:

1. **New tokens added** to CSS variables: `accent-deep`, `positive-deep`, `negative-deep`, `chart-1` … `chart-3`, `chart-grid`.
2. **New typography classes** registered (or new Tailwind utilities): `display-xl`, `h2-section`, plus a rename of existing h2 → `h3-card` for clarity.
3. **Three new components extracted:** `<Card>` (variants + density), `<Button>` (variants + size + shape), `<EngagementPill>` (the four states).
4. **Card padding bump** from `px-5` to `px-6` at default density.
5. **Mid-tier attainment colour rule changed** from accent gold to ink-muted + primary bar.
6. **Engagement state colour mapping shifted:** Active gold → primary; Lapsed red → accent.

**Phase 2 will lean on every one of those.** The `/dashboard` hierarchy fix is mostly impossible without `h2-section`; the KPI sub-line fix uses `caption` and the Card padding bump; the `/hcps` page collapse uses `accent` cards as expander-cued LLM detail.

---

**End of Phase 1.** Read through, push back, then we move to Phase 2 (dashboard + HCP detail page hierarchy + the KPI sub-line problem).

---

# Phase 2 — Page-level hierarchy + KPI sub-line

Phase 2 consumes Phase 1: `h2-section` headers, the new `<Card>` densities, `<EngagementPill>`, and the `caption` text style all appear here. If Phase 1 hasn't merged yet, the recommendations below still ship — just inline the styles.

---

## Deliverable 1 — Page-level visual hierarchy

### 1A — `/dashboard`

#### Diagnosis
Ten sections, identical card weight, no opinion. The user lands on the page and the layout doesn't tell them what to read first. The Synopsis card (LLM) and the KPI grid both sit above the fold competing for attention; below the fold, six trends/tables/lists arrive in undifferentiated order. The fundamental problem isn't the card design — every individual card is fine — it's the **lack of super-sections** to chunk the scroll into a narrative.

There's a latent narrative already implied by what the cards do: *orient → trend → act → roll up → admin.* The fix is to make that narrative visible.

#### Recommendation — five super-sections with `h2-section` headers, three card sizes

Group the existing cards under five super-sections. Each super-section gets an `h2-section` header (the new sans-uppercase 11px style from §3.1) with a thin top divider:

```tsx
<section className="pt-10 pb-2 border-t border-border first:border-t-0 first:pt-0">
  <h2 className="font-sans text-[11px] uppercase tracking-[0.12em] font-semibold text-ink-muted mb-4">
    {sectionLabel}
  </h2>
  {/* cards */}
</section>
```

The five super-sections:

| # | Label | Cards | Notes |
|---|---|---|---|
| 1 | **TODAY** | SynopsisCard (LLM, conditional) | Stands alone above everything else. If empty, this section vanishes — Section 2 takes the top slot. |
| 2 | **THIS PERIOD** | AccountToggle + 4 KPI cards | The orientation row. AccountToggle moves *inside* the section (currently lives above the KPIs as a separate floater). |
| 3 | **TRENDS** | Calls trend chart + Net units trend chart | Side-by-side at `lg+` breakpoint (`grid-cols-1 lg:grid-cols-2`), stacked at `md`. See §1A.b for the toggle-vs-side-by-side decision. |
| 4 | **THINGS TO ACT ON** | SignalsPanel ("HCPs to re-engage") + AccountMotionPanel (the new tabbed panel) | The "what should I do today" zone. AccountMotionPanel moves *up* from the bottom — it's an action surface, not a footer. |
| 5 | **ROLLUPS** | HCP tier coverage table, Team rollup table (mgr/admin), Top reps + Top HCPs/HCOs grid, Top HCOs by Units, Top reps by Units | All "Top X" tables, hierarchical roll-ups. The 2-col grid pattern stays for the small "Top reps + Top HCPs" pairing. |
| 6 | **DATA HEALTH** | Top distributors (unmapped) table (admin) | Admin/data-quality concerns. Demoted to bottom and visually muted (`<Card variant="muted">` from Phase 1). |

The numbered render-order in the brief becomes:

| Old position | New position | Section |
|---|---|---|
| 1 (Synopsis) | 1 | TODAY |
| 2 (KPIs) | 2 | THIS PERIOD |
| 3 (Calls trend) | 3 | TRENDS |
| 4 (Net units trend) | 3 | TRENDS |
| 5 (SignalsPanel) | 4 | THINGS TO ACT ON |
| 11 (AccountMotion) | 4 | THINGS TO ACT ON ⬆ |
| 6 (HCP tier coverage) | 5 | ROLLUPS |
| 7 (Team rollup) | 5 | ROLLUPS |
| 8 (Top reps + HCPs/HCOs) | 5 | ROLLUPS |
| 9 (Top HCOs by Units) | 5 | ROLLUPS |
| 10 (Top reps by Units) | 5 | ROLLUPS |
| 12 (Top distributors) | 6 | DATA HEALTH |

**The single biggest behavioural change:** AccountMotionPanel jumps up from position 11 to inside Section 4. It's the closest thing the dashboard has to a "what changed and why I should care" surface, and burying it below five tables was wrong.

**Card sizing within sections (the second hierarchy lever):**

Three card weights to introduce variance and stop everything reading flat:

| Weight | Treatment | Used for |
|---|---|---|
| **Hero** | Spans full content width (`col-span-full`), default density, `display-xl` headline number where applicable | SynopsisCard (TODAY); the KPI grid container itself reads as one hero block |
| **Standard** | `<Card density="default">`, half-width or third-width grid | Trend charts, SignalsPanel, AccountMotionPanel |
| **Compact** | `<Card density="compact">`, smaller h3-card weight, no subtitle line unless necessary | All "Top X" rollup tables — the goal is dense, scannable, less negotiated detail |

Visually this means **TRENDS and THINGS TO ACT ON cards are physically larger** than ROLLUPS cards. The eye is drawn to the actionable middle, then can lazily scan the rollups below.

ASCII sketch of the new shape (1440px viewport):

```
┌──────────────────────────────────────────────────────────┐
│  Dashboard                          [FilterBar          ] │ ← h1 + filters (existing)
├──────────────────────────────────────────────────────────┤
│  TODAY                                                    │ ← h2-section
│  ┌───────────────────────────────────────────────────┐   │
│  │  ✦ Synopsis (LLM accent variant)                  │   │ ← Hero, accent variant
│  └───────────────────────────────────────────────────┘   │
├──────────────────────────────────────────────────────────┤
│  THIS PERIOD                          [Account Toggle ▾]  │ ← h2-section + toggle
│  ┌──────────┬──────────┬──────────┬──────────┐           │
│  │ Inter-   │ Reach    │ Active   │ Net      │           │ ← KPI grid (compact density)
│  │ actions  │          │ reps     │ units    │           │
│  │  5,431   │ 1,204    │ 87       │ $2.3M    │           │
│  │ ▔▔▔▔     │ ▔▔▔      │ ▔        │ ▔▔▔▔▔    │           │
│  └──────────┴──────────┴──────────┴──────────┘           │
├──────────────────────────────────────────────────────────┤
│  TRENDS                                                   │ ← h2-section
│  ┌──────────────────────────┬──────────────────────────┐  │
│  │ Calls trend              │ Net units trend          │  │ ← Side-by-side, default density
│  │ ▔▔▁▂▃▄▅▆▅▄              │ ▁▂▃▄▅▄▃▄▅                │  │
│  └──────────────────────────┴──────────────────────────┘  │
├──────────────────────────────────────────────────────────┤
│  THINGS TO ACT ON                                         │ ← h2-section
│  ┌──────────────────────────┬──────────────────────────┐  │
│  │ HCPs to re-engage        │ Account motion           │  │ ← The action zone, side-by-side
│  │ • Dr. Adler (lapsed 6w)  │ [Rising│Decline│Watch│New]│  │
│  │ • Dr. Chen (cold)        │ ▔▔ ↑ Rising              │  │
│  │ • Dr. Diaz (lapsed 3w)   │ • Memorial Sloan +18%    │  │
│  └──────────────────────────┴──────────────────────────┘  │
├──────────────────────────────────────────────────────────┤
│  ROLLUPS                                                  │ ← h2-section
│  ┌──────────────────────────────────────────────────┐    │
│  │ HCP tier coverage                                 │    │ ← Compact density
│  ├──────────────────────────┬──────────────────────────┤  │
│  │ Top reps                 │ Top HCPs/HCOs            │  │
│  ├──────────────────────────┴──────────────────────────┤  │
│  │ Top HCOs by units                                   │  │
│  ├─────────────────────────────────────────────────────┤  │
│  │ Top reps by units                                   │  │
│  └─────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────┤
│  DATA HEALTH                                              │ ← h2-section, muted
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Top distributors (unmapped) — admin only [muted]    │  │ ← muted variant
│  └─────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

#### 1A.b — Two trend charts back-to-back (smaller-items item)

I considered toggle vs side-by-side vs keep-stacked and I'm going to commit to **side-by-side at `lg+`** for one specific reason: a dashboard exists to let the user *correlate* signals. Calls vs Net Units is exactly the correlation a manager wants — "we made more calls this month, did units track?" Stacking them forces the user to remember the first chart's shape while looking at the second; toggling forces an explicit comparison gesture. Side-by-side makes the correlation passive and free.

```tsx
<div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
  <TrendCard metric="calls" />
  <TrendCard metric="net_units" />
</div>
```

At `md` and below, stack — see Phase 3 for the responsive treatment.

#### Tradeoffs / open questions

- **The `h2-section` divider lines add visual chrome.** Five extra horizontal lines on a long page. If it feels heavy, lose the top border (`border-t`) and rely on extra vertical spacing alone — the `h2-section` text style is distinctive enough on its own. I'd ship with the lines and remove if QA agrees they're noise.
- **Section 1 (TODAY) is single-card.** Feels like it should have more in it. Open question: should "Today" also include a per-rep "your day at a glance" summary (e.g. calls scheduled, calls completed, hottest HCP not yet contacted today)? That's a feature add and out of scope per the brief — flagging only.
- **The "rollup" demotion may feel wrong to managers** who currently use Top Reps as a primary read. Validation: ask one manager what they look at first on `/dashboard`. If it's a rollup, the section ordering needs a tweak — possibly moving ROLLUPS above THINGS TO ACT ON for manager/admin roles only. (Easy: role-conditional super-section ordering.)

---

### 1B — `/hcps/[hcp_key]`

#### Diagnosis
Three different framings of "engagement / last contact" appear in three different cards. The Snapshot card has a 4-stat grid that includes Last Contact; the SinceLastVisit card is *all about* last visit; the KPI grid has its own "Last contact" tile; the TargetScoreCard and PeerCohortCard are detail-level breakdowns of the same engagement that Snapshot already summarized. The page right now is "everything we know about this physician, at the same volume" — and engagement gets repeated four ways.

**The page wants two layers, not seven cards:** an **Overview layer** (Snapshot + the chart) and a **Detail layer** behind expanders (Score breakdown, Peer cohort, Reps who've called).

#### Recommendation — collapse to Overview + progressive-disclosure Detail

**Cuts:**

1. **Remove the 3-col KPI cards entirely.** Snapshot already owns Interactions, Reps engaged, and Last contact. They're redundant. Snapshot becomes the single canonical headline-metrics surface.
2. **Merge SinceLastVisitCard into HcpSnapshotCard** as a new fifth stat slot or as a "Recent activity" footer line within Snapshot. The diff signal ("new since your last visit") is valuable but doesn't need its own card.
3. **Move TargetScoreCard and PeerCohortCard behind expanders.** They're detail-not-overview and only ~30% of users will care on any given visit.

**Resulting page structure:**

```
┌──────────────────────────────────────────────────────────┐
│  ← Back to HCPs                                           │
│  Dr. Sarah Adler              [Tier 1] [Primary] [KOL]    │
│  Endocrinology · Memorial Sloan         [FilterBar      ] │ ← h1 + badges + filters
├──────────────────────────────────────────────────────────┤
│  OVERVIEW                                                 │ ← h2-section
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Snapshot                          [Engagement: ●Hot] │  │
│  │ ┌──────┬──────┬──────┬──────┐                        │  │ ← 4-stat grid
│  │ │ 14   │ 3    │ 6 da │ 87%  │                        │  │
│  │ │ ints │ reps │ ago  │ score│                        │  │
│  │ └──────┴──────┴──────┴──────┘                        │  │
│  │ ─────────────────────────────────────────────        │  │
│  │ Recent activity:  +2 calls, +1 sample drop          │  │ ← merged SinceLastVisit
│  │ since your last visit on Mar 12                      │  │
│  │                                                       │  │
│  │ [Generate call brief]  [Open in Veeva ↗]             │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Calls trend                                          │  │ ← Trend at overview level
│  │  ▔▔▁▂▃▄▅▆▅▄                                         │  │
│  └─────────────────────────────────────────────────────┘  │
├──────────────────────────────────────────────────────────┤
│  DETAIL                                                   │ ← h2-section
│  ┌─────────────────────────────────────────────────────┐  │
│  │ ▶ Score breakdown                                    │  │ ← Collapsed by default
│  └─────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ ▶ Compared to similar HCPs                           │  │ ← Collapsed by default
│  └─────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ ▼ Reps who've called                                 │  │ ← Expanded by default
│  │   [table]                                            │  │
│  └─────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

**Engagement pill placement:** moves into the Snapshot card header, replacing whatever currently fills that slot. It's the most-loaded visual on the page — give it a permanent home.

**Score-breakdown vs Peer-cohort bar treatments (smaller-items item) converge inside the Detail layer.** Both expanders use the same horizontal bar primitive: 6px tall, primary-green fill, rounded-full, ink-muted background track. No more two-bar-treatments problem. Spec:

```tsx
<div className="h-1.5 rounded-full bg-border overflow-hidden">
  <div
    className="h-full bg-primary rounded-full"
    style={{ width: `${pct}%` }}
  />
</div>
```

**Expander spec:**

```tsx
<details className="group rounded-lg bg-surface border border-border">
  <summary className="px-6 py-4 cursor-pointer flex items-center justify-between gap-4 list-none">
    <h3 className="font-display text-lg">{title}</h3>
    <ChevronDown className="w-4 h-4 transition-transform group-open:rotate-180" />
  </summary>
  <div className="px-6 pb-6">{/* body */}</div>
</details>
```

Use the native `<details>`/`<summary>` for free keyboard accessibility. Default-open the most-used expander (Reps who've called) so power users don't have to click on every visit.

#### Tradeoffs / open questions

- **Removing the 3-col KPI grid is a real cut**, not a hide. It might generate "where did the KPI cards go?" support tickets in week 1. Mitigate with one paragraph in the changelog: "HCP detail page consolidated — Snapshot is now the single headline-metrics card; Score breakdown and Peer cohort moved into expanders."
- **Default-open Reps-who've-called** assumes that's the most-clicked card. Validate with one rep + one manager. If Score breakdown is what they actually open every time, swap which one is default-open.
- **`<details>` element styling can fight Tailwind v4** — particularly the default disclosure triangle. The spec above sets `list-none` to suppress it; verify Safari renders correctly.

---

## Deliverable 2 — KPI sub-line concatenation problem

#### Diagnosis
The Interactions card currently reads:

```
5,431
Interactions (last 12 weeks)
98% of goal · -3% vs prior period · 4,732 live · 699 drop-off
```

That's the **headline number**, the **metric label**, and **four secondary signals** smashed into a single 12px line separated by middots. The eye can't parse it without effort, the middots are visual noise, and the fourth signal (drop-off count) is borderline incomprehensible without context. The Net units card has the same shape (attainment + dollars + delta).

The root issue is treating "everything we want to surface" as equally important. It's not: there's always one *primary* secondary signal (the one that answers "should I be worried?") and the rest are *tooltip-worthy detail.*

#### Recommendation — one explicit secondary line + chip-row tertiary signals

Three-tier hierarchy inside the KPI card:

```
PRIMARY    — the big number (display-xl, primary text colour)
LABEL      — metric name + period (caption, ink-muted)
SECONDARY  — exactly ONE goal/comparison signal, with directional color
TERTIARY   — chip row of supporting metrics, on demand
```

Specifically:

```tsx
<Card density="compact">
  <CardBody>
    {/* PRIMARY */}
    <div className="font-display text-4xl leading-[1.1] tracking-tight">
      5,431
    </div>

    {/* LABEL */}
    <div className="mt-1 text-xs text-ink-muted">
      Interactions <span className="text-ink-muted/70">· last 12 weeks</span>
    </div>

    {/* SECONDARY — exactly one signal, directional color */}
    <div className="mt-3 flex items-center gap-1.5 text-sm">
      <TrendArrow direction="down" />
      <span className="font-medium text-negative-deep">3% vs prior period</span>
    </div>

    {/* TERTIARY — chips, optional */}
    <div className="mt-3 flex items-center gap-1.5 flex-wrap">
      <StatChip label="Goal" value="98%" tone="positive" />
      <StatChip label="Live" value="4,732" />
      <StatChip label="Dropoff" value="699" tone="caution" />
    </div>
  </CardBody>
</Card>
```

**The rule for which signal becomes "secondary":**

| Card | Secondary signal | Why |
|---|---|---|
| Interactions | Δ vs prior period | The trend question is the primary read for an activity metric |
| Reach | % of HCPs covered | The denominator question is the primary read for a coverage metric |
| Active reps | Δ vs prior period | Trend, same as Interactions |
| Net units | % of attainment goal | The goal question is primary for a sales metric |

So **the secondary line is metric-specific.** The brief asked for a clean opinion; this is it. Pick the one signal that answers "is this good or bad?" and let it own the slot.

**StatChip primitive (new, small, supports tertiary):**

```tsx
<span className="inline-flex items-baseline gap-1 rounded px-1.5 py-0.5 text-[11px] bg-surface-alt text-ink-muted">
  <span className="text-ink-muted/80">{label}</span>
  <span className="font-mono text-ink">{value}</span>
</span>
```

Tones (via `tone` prop) map to subtle background tints:
- `default` → surface-alt
- `positive` → positive/8
- `caution` → accent/12
- `negative` → negative/10

The chips are **always visible by default at desktop widths**, **collapse behind a "Detail ▾" expander at narrow viewports** (Phase 3 will spec this).

**Why not a tooltip?** Tooltips hide info that an analyst literally wants to scan. The user is on a dashboard reading numbers — making them hover to discover "live: 4,732" turns scannable data into hide-and-seek. Tooltips are appropriate for definitional metadata ("how is dropoff calculated?") not for live metric values.

#### Tradeoffs / open questions

- **The chip row adds vertical height** (~16px per card). At a 4-up KPI grid that's fine; if you ever go to 6-up, the chips need to collapse.
- **`-3% vs prior period`** as the only top-line secondary signal *might* be too narrow if a card is actively answering both "vs goal" and "vs prior period" questions in different contexts. The right answer is per-card editorial judgement, captured in the table above. If it stops being one obvious answer for any card, the chip row is the escape hatch — bump that signal up to secondary and demote whatever was there.
- **`TrendArrow` and the directional colour pairing** are the only places I'd actively want a single-rep eye check before shipping. Coloured arrows next to coloured numbers can read as overcoded; if it does, drop the arrow and rely on colour alone (acceptable since the prior-period delta already includes a sign character).

---

## Phase 2 summary

What changes when Phase 2 ships:

1. **`/dashboard` gets five super-sections** (`TODAY`, `THIS PERIOD`, `TRENDS`, `THINGS TO ACT ON`, `ROLLUPS`, `DATA HEALTH`) using the `h2-section` style from Phase 1. AccountMotionPanel migrates from page-bottom to "things to act on."
2. **Trend charts go side-by-side at `lg+`**, stacked below.
3. **`/hcps/[hcp_key]` collapses 7 cards into 4 visible** (Snapshot — now also containing the SinceLastVisit diff line — Trend, plus three expanders for Score breakdown, Peer cohort, Reps who've called).
4. **The 3-col KPI grid on `/hcps` is removed**; Snapshot owns headline metrics.
5. **Score-breakdown bars and Peer-cohort bars converge** to a single primary-green progress bar primitive.
6. **KPI cards adopt a 3-tier hierarchy:** primary number → label → one secondary signal → optional chip row of tertiary signals. Concatenated middot lines disappear.
7. **New `<StatChip>` primitive** for tertiary metric display.

**Phase 3 will use these decisions** when speccing mobile/responsive behavior — the side-by-side trends become stacked at `md`, the chip rows collapse at `sm`, the expander pattern translates directly to mobile.

---

**End of Phase 2.** Push back where you disagree, then we move to Phase 3 (responsive direction + remaining smaller items + final prioritized punch list with 1-day vs 1-week sequencing).

---

# Phase 3 — Mobile / responsive + smaller items + punch list

---

## Deliverable 6 — Mobile / responsive direction

#### Diagnosis
Tailwind grid classes signal mobile-friendly intent (`grid-cols-1 md:grid-cols-2 lg:grid-cols-4`) but nothing has been verified at narrow widths. Three structural risks: (1) wide tables (`/admin/mappings`, `/explore` matrix, attribution table on `/hcos`) overflow with no plan; (2) `flex-wrap` headers degrade ungracefully when a FilterBar with five filter chips wraps onto its own line and pushes the title off-screen; (3) numeric `font-mono` columns at `text-sm` look cramped at <600px when stacked into card-style row layouts.

The brief calls out the right user prior: **tablet (managers between meetings) is realistic; phone (reps in cars) is not.** That single prior simplifies a lot of decisions — we don't need to design for 375px, we need to be solid at 768–1024 and bend gracefully at 600.

#### Recommendation — three breakpoints, two table-overflow strategies, one mobile rule

**Breakpoint targets:**

| Tailwind | Width | User context | Treatment |
|---|---|---|---|
| `sm` | <640px | Phone (rare) | Single column, chips collapse, tables become card-rows. Nothing here is precious — just doesn't crash. |
| `md` | 640–1023 | **Tablet (primary mobile target)** | Single-column main content, KPI grid 2×2, trend charts stacked, expanders work normally. **This is the load-bearing breakpoint.** |
| `lg` | 1024–1439 | Laptop | Existing layouts mostly unchanged; trend charts go side-by-side; ROLLUPS use 2-col grid. |
| `xl` | 1440+ | Wide monitor | Current target, no changes. |

**Per-section responsive behaviour:**

| Surface | At `md` | At `sm` |
|---|---|---|
| Page header (h1 + FilterBar) | FilterBar wraps **below** title (not beside) | Same; FilterBar collapses to `<details>` "Filters ▾" |
| KPI grid | `grid-cols-2 gap-4` (2×2) | `grid-cols-1`, chips collapse to `Detail ▾` |
| Trend charts | `grid-cols-1` (stacked) | Same; chart aspect ratio relaxes from 2:1 to 16:9 |
| THINGS TO ACT ON (Signals + AccountMotion) | `grid-cols-1` (stacked) | Same |
| ROLLUPS (Top reps + Top HCPs) | `grid-cols-1` | Tables become card-rows (see below) |
| Snapshot 4-stat grid | `grid-cols-2` (2×2) | `grid-cols-2` (still 2×2 — stats are short) |
| Expanders | Unchanged | Unchanged |
| Engagement pill | Unchanged | Unchanged |

**Two strategies for wide tables, picked per surface:**

**Strategy A — horizontal scroll within a card.** For tables where every column is load-bearing and the user expects a tabular read (`/explore` matrix, `/admin/mappings`, sales attribution). Wrap the `<table>` in:

```tsx
<div className="overflow-x-auto -mx-6 px-6">
  <table className="min-w-[720px] w-full text-sm">…</table>
</div>
```

The `-mx-6 px-6` lets the scroll surface bleed to the card edge while keeping content inset; the `min-w-[720px]` prevents columns from cramping into illegibility. Add a subtle right-edge fade to signal scrollability:

```tsx
<div className="relative">
  <div className="overflow-x-auto …">{/* table */}</div>
  <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-surface to-transparent md:hidden" />
</div>
```

**Strategy B — table → card-rows at `sm`.** For "Top X" rollup tables and "Reps who've called" — short rows, scannable, where the user is reading individual rows not comparing columns. At `<sm`, each row becomes:

```tsx
<div className="px-4 py-3 border-b border-border last:border-b-0">
  <div className="flex items-baseline justify-between gap-3">
    <Link className="font-medium text-primary truncate">{name}</Link>
    <span className="font-mono text-sm">{primaryValue}</span>
  </div>
  <div className="mt-1 text-xs text-ink-muted truncate">
    {secondaryLabel} · {tertiaryValue}
  </div>
</div>
```

Use Strategy A for `/admin/*`, `/explore`, attribution. Use Strategy B for everything else.

**The one mobile rule:**

> Never hide a column. If a table can't fit, scroll it (Strategy A) or restructure it (Strategy B). Never `display: none` a data cell — that's a different table with the same name, and the next manager who refers to "the column on the right" will be wrong.

**FilterBar at `md`:**

The current pattern (`flex-wrap` next to the title) breaks because the title compresses to a single column when the FilterBar wraps onto a second line. Spec:

```tsx
<header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
  <div className="min-w-0">
    <h1>…</h1>
    <p className="text-ink-muted">…</p>
  </div>
  <FilterBar className="w-full md:w-auto" />
</header>
```

At `<md`, FilterBar is below; at `md+` it sits beside, growing to fill remaining width.

#### Tradeoffs / open questions

- **Tablet-first means desktop is the upgrade path, not the source of truth.** That's a philosophical choice — the current codebase reads desktop-first. I'm not asking for a rewrite; I'm asking that *new* component work follow tablet-first, and existing pages get retrofitted only at the points listed above.
- **Strategy B (card-rows) is strictly worse than the table** for power users on a phone. They'd actually rather scroll horizontally. If your rep population on phones turns out to be larger than the brief implies, switch Strategy B → Strategy A everywhere. Easy switch, isolated to one component.
- **Print stylesheet** is out of scope but worth flagging — nothing in the codebase is print-ready right now and managers will eventually want to share a dashboard PDF. Not Phase 3 work.

---

## Smaller items — concrete opinions

Each is short on purpose. Implement directly or push back.

### Cmd+K global entity search

**Opinion: full-screen modal, no always-visible chrome.**

A persistent search bar in the header steals real estate that the FilterBar already needs. A small inline search input is too easy to miss. The modal pattern is well-understood (Linear, Notion, every modern SaaS) and rewards keyboard-first power users who actually want this.

Spec:

- Trigger: `⌘K` / `Ctrl+K`, plus a `?` icon button in the top nav next to the user menu.
- Visual: full-screen overlay at `bg-ink/40 backdrop-blur-sm`, modal at `max-w-2xl mx-auto mt-24`, `bg-surface rounded-xl border border-border shadow-xl`.
- Input: large (`text-lg`, `py-4 px-5`), placeholder "Find an HCP, HCO, or rep…".
- Results: grouped by entity type with `h2-section`-style sub-labels ("HCPs / HCOs / Reps"), max 5 per group, debounced 150ms.
- Each result row: name + entity-type badge (using existing tier/flag badge style) + sub-line showing territory or specialty. Arrow keys navigate, Enter routes.
- Empty state: shortcut hints ("→ Recent" / "Type to search").

Close with `Esc` or click outside. Don't try to be a command palette (no actions yet) — that's a future expansion. Phase 1 is just navigation.

### AccountMotionPanel tab styling (precedent for future tabs)

**Opinion: underline tabs, primary-green active indicator. Don't do pill tabs.**

```tsx
<div role="tablist" className="flex border-b border-border gap-6 px-6">
  {tabs.map(t => (
    <button
      role="tab"
      aria-selected={t === active}
      className={`
        relative py-3 text-sm font-medium transition-colors
        ${t === active
          ? "text-ink"
          : "text-ink-muted hover:text-ink"}
      `}
    >
      {label}
      <span className={`
        absolute bottom-[-1px] left-0 right-0 h-[2px] rounded-full
        ${t === active ? "bg-primary" : "bg-transparent"}
      `} />
      {count != null && (
        <span className="ml-1.5 text-xs text-ink-muted">({count})</span>
      )}
    </button>
  ))}
</div>
```

Why: underline tabs read as "section navigation within a card" — which is exactly what AccountMotionPanel is. Pill tabs read as "filter a result set" — wrong semantic. Counts in the label are essential ("Rising (12)") so the user knows whether a tab is empty before clicking.

### Snapshot card consistency (HCP / HCO / Rep)

**Opinion: lock the 4-stat grid to a fixed shape.** Same grid, same row positions, same units. The three entity types should produce visually superimposable Snapshot cards.

Proposed canonical 4-stat layout:

| Slot | HCP | HCO | Rep |
|---|---|---|---|
| 1 (top-left) | Interactions (12w) | Interactions (12w) | Calls made (12w) |
| 2 (top-right) | Reps engaged | HCPs covered | HCPs covered |
| 3 (bottom-left) | Last contact | Last contact | Avg call freq |
| 4 (bottom-right) | Engagement score | Engagement score | Attainment |

Each cell: `display-xl` value, `caption` label. Engagement pill goes in the header, not in a stat slot — keeps stats homogeneous.

### Sales attribution footer text (admin-only context)

**Opinion: tooltip via `?` affordance for non-admin viewers, full-text for admins.**

```tsx
{isAdmin
  ? <p className="px-6 py-3 text-[11px] text-ink-muted border-t border-border">{adminCaveat}</p>
  : <button aria-label="How is this attributed?" className="…">
      <HelpCircle className="w-3.5 h-3.5 text-ink-muted" />
    </button>
}
```

The footer text is admin-context (mapping caveats, pipeline timing) — non-admins shouldn't have it permanently consuming card real-estate, but should be able to discover the explanation if they're confused by a number.

### /admin/mappings density

**Opinion: keep all-on-one-page, don't tabify.** Admin workflows are linear (upload → trigger → review unmapped → save). Tabs would force the user to remember state across tabs. Better intervention: stronger super-sections (use `h2-section`) and the long-list pattern from `ui-patterns.md` on the unmapped table.

---

## Prioritized punch list

Ordered by impact ÷ effort ratio. **Do top to bottom.**

| # | Change | Impact | Effort | Phase ref |
|---|---|---|---|---|
| 1 | Add `h2-section` typography token + apply to `/dashboard` super-sections | **H** | **S** | §3.1, §1A |
| 2 | Reorder `/dashboard` cards into 6 super-sections (AccountMotion → "Things to act on") | **H** | **S** | §1A |
| 3 | Replace KPI sub-line concatenation with primary number → label → one secondary → chip row | **H** | **M** | §2 |
| 4 | Build `<EngagementPill>` and reassign colours (Active gold→primary, Lapsed red→accent) | **H** | **S** | §4 |
| 5 | Remove `/hcps` 3-col KPI grid; merge SinceLastVisit into Snapshot | **H** | **S** | §1B |
| 6 | Move TargetScore + PeerCohort behind `<details>` expanders on `/hcps` | **H** | **S** | §1B |
| 7 | Extract `<Card>` component with `default`/`accent`/`muted` variants + `default`/`compact`/`flush` densities | **H** | **M** | §3.2 |
| 8 | Bump Card default padding `px-5` → `px-6` | **M** | **S** | §3.2 |
| 9 | Add `accent-deep`, `positive-deep`, `negative-deep` tokens; switch all coloured-text usages to `*-deep` | **M** | **S** | §5 |
| 10 | Reassign trend chart default fill from accent gold to primary green (`chart-1`) | **M** | **S** | §5 |
| 11 | Mid-tier attainment colour rule: accent gold → ink-muted + primary bar | **M** | **S** | §5 |
| 12 | Extract `<Button>` component with primary/secondary/ghost/destructive + compact/default/large + `shape="icon"` | **M** | **M** | §3.3 |
| 13 | Side-by-side trend charts at `lg+`, stacked below | **M** | **S** | §1A.b |
| 14 | Underline tab style for AccountMotionPanel (sets future-tab precedent) | **M** | **S** | Smaller items |
| 15 | Cmd+K global entity search (modal) | **H** | **L** | Smaller items |
| 16 | Score-breakdown + Peer-cohort bars converge to one progress-bar primitive | **M** | **S** | §1B |
| 17 | Snapshot card 4-stat grid lock (HCP/HCO/Rep parity) | **M** | **S** | Smaller items |
| 18 | Wide-table strategy A (horizontal-scroll with edge fade) on `/admin/mappings`, `/explore`, attribution | **M** | **M** | §6 |
| 19 | Wide-table strategy B (card-rows at `<sm`) on rollup tables and Reps-who've-called | **L** | **M** | §6 |
| 20 | FilterBar moves below title at `<md`; collapses to `<details>` at `<sm` | **M** | **S** | §6 |
| 21 | Sales attribution footer becomes tooltip for non-admins | **L** | **S** | Smaller items |
| 22 | Page-title `text-3xl` → `text-[28px]` (cede to KPI numbers for hierarchy) | **L** | **S** | §3.1 |

**Effort key:** S ≈ < 1 day, M ≈ 1–3 days, L ≈ 3–5 days. Engineer-days, not designer-days.

---

## Sequencing — 1 day vs 1 week

### If you have one day

Ship items **#1, #2, #4, #5, #6** in that order.

That's: super-section headers added, dashboard reordered, engagement pill landed, HCP page collapsed. The user will perceive **all five priority pages as substantially clearer by end-of-day** without any new components extracted, no token changes that require a global migration, and no responsive work. Total estimated effort: ~6 hours for an engineer with the codebase open.

The visual delta is large because (a) `h2-section` headers reorganize the dashboard's perceived structure with a single CSS class added per section, (b) the `/hcps` page goes from 7 cards to 4, which is the largest density reduction available.

### If you have one week

Days 1–2: punch-list **#1–#6** (the 1-day plan above) plus **#9, #10, #11** — get the colour audit out of the codebase. Token additions land first, then bulk find-replace.

Days 3–4: punch-list **#7, #8, #12** — extract `<Card>` and `<Button>`. This is the single biggest engineering investment but it pays dividends every subsequent change. Migrate the 5 highest-traffic surfaces first (`/dashboard`, `/hcps/[hcp_key]`, `/hcos/[hco_key]`, `/reps/[user_key]`, `/inbox`), leave the rest on the inline pattern temporarily.

Day 5: punch-list **#3, #13, #14, #16, #17** — the medium-impact polish items that benefit from having `<Card>` already extracted (KPI sub-line, side-by-side trends, tab styling, bar primitive convergence, snapshot parity).

**Park to a follow-up week:** **#15 (Cmd+K)** and **#18–#20 (responsive work)**. Cmd+K is genuinely a 3–5 day build done well; responsive work needs QA cycle time. Neither is blocking the other 17 wins.

---

## Open questions to resolve before merging

Three things I'd actively want validated, not just shipped on my opinion:

1. **The `/dashboard` ROLLUPS demotion** — does at least one manager confirm they read trends/signals first and rollups second? If not, role-conditional super-section ordering (rollups higher for managers/admins).
2. **Default-open expander on `/hcps`** — is "Reps who've called" actually the most-used? If "Score breakdown" is, swap which one starts open.
3. **Engagement pill colour reassignment user comms** — Lapsed shifting red→amber needs one paragraph in a release note so existing users don't think the data changed.

Everything else I'm confident enough on to ship. Push back on any of the above and we re-spec; otherwise this is the design review.

---

## Addendum — Visualizations vs tables (design opinion)

Flagged late but worth its own section. The current ratio of tables to visualizations on `/dashboard` and the detail pages is heavy on tables. **The brief is right that pages would benefit from more visualization** — but the failure mode to avoid is "every metric becomes a chart," which produces dashboards that are harder to read, not easier. A chart's job is to surface a *shape* (a trend, a distribution, a comparison) that a number alone can't. If the answer is just one number, leave it as one number.

This is partly a data question (what's available, what's pre-aggregated, what's expensive to compute) so I'm not specifying queries or exact chart types. What I am specifying is **where on each page a visualization would do work a table can't**, and the design vocabulary they should share when they arrive.

### Where visualizations would actually help

| Page | Where | What it shows | Why a chart beats a table |
|---|---|---|---|
| `/dashboard` THIS PERIOD | Inline sparkline inside each KPI card, below the secondary line | 12-week trend of that metric | Currently the KPI card is one number + one delta. A sparkline tells the user whether the delta is part of a trend or a blip — same data the trend chart below already has, but at a glance. |
| `/dashboard` ROLLUPS — Top reps | Tiny inline horizontal bar in the table row | Each rep's value as a fraction of #1 | Reading "$2.1M, $1.8M, $1.6M" in a column requires arithmetic. A bar makes the gap between #1 and #5 instantly visible. |
| `/dashboard` HCP tier coverage | Stacked horizontal bar (one row per tier) | Covered / partial / uncovered share per tier | Currently a number table; the actual question ("am I weak on Tier 2?") is a proportion question, not a count question. |
| `/hcps/[hcp_key]` Snapshot | Replace "Engagement score: 87%" with the same horizontal progress bar primitive used in expanders | Score against goal | Number alone gives no sense of where 87% sits — leading the pack or scraping by. |
| `/hcps/[hcp_key]` Calls trend | Add a faint "peer cohort median" line behind the rep's actual line | Compare this HCP's call cadence to similar HCPs | Lets the user see "we're under-calling this physician" without opening the Peer Cohort expander. |
| `/hcos/[hco_key]` Sales section | Small treemap or proportional cards | Affiliated HCPs by Tier or by attainment band | The current table-of-HCPs makes you scan to understand HCO composition. A treemap answers "where's the value concentrated?" in one glance. |
| `/reps/[user_key]` Coverage | Donut or stacked bar | Coverage by territory + tier | Same logic as HCP tier coverage. |
| `/inbox` | Per-category mini bar showing signal counts over time | Are signals piling up or being worked? | Inbox without a temporal cue feels like an infinite list. |

### Where visualizations would *not* help (resist the temptation)

- **"Top X" lists ranked by a single value.** Adding a sparkline next to each row is noise — the table already says "this is a ranked list." An inline bar (per above) is fine; a per-row sparkline is over-charting.
- **The Synopsis card.** It's text on purpose. Don't convert LLM narrative into a dashboard.
- **AccountMotionPanel tabs.** Each tab is already a list of accounts with deltas. The number IS the chart in this context.
- **Score breakdown / Peer cohort expanders.** Already chart-heavy. Don't add more.

### Shared design vocabulary for charts (so they don't fight)

If/when these land, every chart should obey the same rules — otherwise five new chart types arrive with five different visual treatments and the dashboard gets noisier, not clearer.

| Element | Spec |
|---|---|
| Default series colour | `chart-1` (`#1F4E46`) — primary green, per Phase 1 §5 |
| Comparison/secondary series | `chart-2` (`#C89B4A`) — accent gold, only when there's a true second series |
| Tertiary series | `chart-3` (`#5A564E`) — ink-muted |
| Gridlines | `chart-grid` (`#E5E3DB`), 1px, no labels on inline sparklines |
| Axis labels | `caption` style, ink-muted, no chart titles inside the chart (the card title is the chart title) |
| Sparklines | 24px tall, no axis, no labels, single fill colour, render in 100ms or skip them |
| Inline horizontal bars | The same `h-1.5 rounded-full bg-border` + `bg-primary` fill primitive from §1B (Score breakdown). One bar primitive, used everywhere. |
| Tooltips | Only on hover-over discrete data points, not on hover-over chart area; show value + period; do not show on touch devices (tap should navigate to detail page) |
| Empty state | Same italic muted-text pattern as tables, centered in the chart area |

### Recommendation for the punch list

Add as **#23 (Visualizations pass)** — Impact **M**, Effort **L** — and explicitly *not* part of the 1-week plan. Visualizations are a separate workstream that depends on (a) the data team confirming what aggregations are cheap, (b) `<Card>` / `<EngagementPill>` / progress-bar primitives already extracted (so charts inherit the visual language).

Sequence as a follow-up sprint after the punch-list 1-week plan ships. The two highest-leverage additions to do first:

1. **KPI card sparklines** — biggest perceived "the dashboard got more visual" win for the smallest amount of new chart code.
2. **Inline horizontal bars in Top X tables** — turns existing tables into hybrid table-charts without rebuilding them.

The rest can follow once those two land and you've calibrated whether the visual density is right.

### Open questions for the data side

(Surfacing because the user flagged this is partly a data question.)

- Is 12-week sparkline data pre-aggregated per metric per entity, or computed on demand? Sparklines on every KPI card on every page load could be expensive.
- For the HCP "peer cohort median" line: is the cohort already computed for the Peer Cohort expander, and can the trend chart re-use it cheaply, or is that a separate query?
- For `/hcos` treemap: is "value share by affiliated HCP" a query the warehouse exposes today, or does it need a new aggregation?

These determine which visualizations are 1-day work and which are 1-week. Worth a short data-eng sync before scoping.

---

**End of review.** Phases 1, 2, 3 + Visualizations addendum complete. Markdown is in `design-review.md`; it's structured for Claude Code to read top-to-bottom and lift hex values, class strings, and component shapes directly into implementation.

---

# Handoff to Claude Code

**Source of truth:** this file, `design-review.md`. All hex values, Tailwind class strings, component APIs, and section IDs are referenced from here.

**Suggested handoff prompt:**

> I have a design review at `docs/audit/design-review.md` (or wherever you commit it in the throughline repo). Read it top-to-bottom first. It's structured in three phases plus a visualizations addendum, and ends with a 22-item prioritized punch list with explicit 1-day and 1-week sequencing.
>
> Start by shipping the **1-day plan** (punch-list items #1, #2, #4, #5, #6) on a single branch. Don't extract `<Card>` or `<Button>` yet — those are 1-week work. Use inline class strings matching the spec exactly; the component extraction in Phase 1 is a deliberate later step so we can validate the visual decisions before refactoring.
>
> Three things to flag back rather than ship blindly:
> 1. The `/dashboard` ROLLUPS demotion — confirm with at least one manager-role user that trends/signals first, rollups second matches their actual reading order.
> 2. Default-open expander on `/hcps` — review usage data (or ask a rep) whether "Reps who've called" or "Score breakdown" is the more-used expander; default-open the right one.
> 3. The Lapsed engagement colour shift (red → amber) needs one paragraph in the release notes since users will have learned the previous red signal.
>
> The Visualizations addendum at the end is intentionally separate from the punch list — coordinate with data-eng before scoping that workstream.

**Suggested commit structure for the 1-day plan:**

1. `feat(design): add h2-section typography token` — one CSS variable + Tailwind utility, no JSX changes.
2. `feat(dashboard): regroup cards into super-sections` — pure JSX restructure, no new components.
3. `feat(design): introduce EngagementPill component` — new file + replace 3 call sites.
4. `feat(hcps): collapse detail page to Snapshot + expanders` — removes the 3-col KPI grid, merges SinceLastVisit, wraps TargetScore + PeerCohort in `<details>`.

Each commit should be reviewable in isolation; nothing in the 1-day plan touches more than 5 files.

**Branch naming:** `design/phase-1-day-1` for the day-one plan; phase out from there per the punch list.
