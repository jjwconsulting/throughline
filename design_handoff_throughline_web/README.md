# Handoff: Throughline Web App — Design System & UI Kit

## Overview

This handoff documents the **Throughline web application** — a commercial analytics SaaS for life sciences (pharma / biotech commercial ops). It covers the design system (colors, type, content fundamentals) plus a pixel-level UI kit recreating the authenticated app shell, dashboard, inbox, HCP/Rep detail pages, and the full Admin section (Tenants, Users, Mappings, Goals, Pipelines).

> "Throughline" is a working codename — the real brand has not been chosen. Treat the wordmark as a placeholder. The kit's `brand` prop / Tweaks panel makes it trivial to swap.

## About the Design Files

The files in this bundle are **design references created in HTML/JSX inline-Babel** — interactive prototypes showing intended look, structure, and behavior. **They are not production code to copy directly.**

The real codebase lives at `github.com/jjwconsulting/throughline` and is **Next.js 16 + Tailwind v4 + Drizzle + Clerk + Microsoft Fabric**. Your task is to take the design decisions captured here and apply them inside that existing environment using its established patterns. The mock screens in `ui_kits/web/Screens.jsx` were modeled directly on the real `apps/web/app/(app)/admin/*/page.tsx` files — column shapes, copy, and section structure should match what's already there. Where the real codebase already has a working version (Tenants, Users, Goals, Mappings, Pipelines), prefer the real code; use the mocks as the visual/structural target.

## Fidelity

**High fidelity.** Final colors, typography, spacing, and component shapes. Recreate pixel-perfectly using the existing Tailwind v4 `@theme` tokens in `apps/web/app/globals.css` — those tokens are the source of truth and are mirrored verbatim in `colors_and_type.css` here.

## What's in this bundle

| Path | What it is |
|---|---|
| `colors_and_type.css` | All 13 color tokens + typography scale + radius/spacing primitives. Mirror of the repo's Tailwind `@theme` block. |
| `ui_kits/web/index.html` | Mounts the React app, wires the Tweaks panel, owns palette/accent overrides. |
| `ui_kits/web/Primitives.jsx` | `Card`, `CardHeader`, `PrimaryButton`, `Chip`, `SeverityDot`, `SeverityIcon`, `Eyebrow`. |
| `ui_kits/web/Nav.jsx` | Top nav, BrandMark, Admin sub-nav, FilterBar, AccountToggle, Select. |
| `ui_kits/web/Icons.jsx` | Thin-line icon set (lucide-style, 1.5px stroke, currentColor). 18 icons covering nav, severity, and misc. |
| `ui_kits/web/Panels.jsx` | `KpiCard`, `SignalsPanel`, `Briefing`, `TrendChart` (SVG), `DataTable`. |
| `ui_kits/web/Screens.jsx` | All page recreations: Landing, Dashboard, Inbox, HcpDetail, RepDetail, AdminTenants, AdminUsers, AdminMappings, AdminGoals, AdminPipelines. |
| `ui_kits/web/tweaks-panel.jsx` | The host-protocol Tweaks shell (palette/accent/brand swapping). Demo-only — strip from production. |

## Screens / Views

### 1. Landing (`route: "landing"`)

- **Purpose**: marketing-style entry point that links into the demo.
- **Layout**: full-viewport flex center, max-width 640px column.
- **Content** (lifted from repo):
  - Eyebrow: `THROUGHLINE · WORKING NAME` — `text-xs uppercase tracking-widest text-[var(--color-accent)]`
  - Hero h1: *"Commercial analytics for life sciences."* — `font-display text-6xl leading-tight`
  - Sub: *"Unified field, sales, and engagement data — delivered through embedded Power BI, backed by Microsoft Fabric, configured in minutes."* — `text-lg text-ink-muted`
  - CTA: `PrimaryButton` → "Enter demo"

### 2. App shell (every authed page)

- **Top nav** — 56px (`h-14`), `bg-surface border-b border-border`, max-width 1152px container, `px-6`.
  - Left: braided BrandMark (3 wave lines + 1 gold underline) + wordmark in `font-display text-xl`. Both lift off `--color-primary` for the strokes and `--color-accent` for the underline.
  - Center/right: nav links (Dashboard, Inbox, Reports, Admin, Settings) — each is `inline-flex` with a 14px icon + label. Active link gets `bg-surface-alt` pill and `text-ink`; inactive is `text-ink-muted` → hover `text-ink`. **Mappings is NOT a top-level link** (lives under Admin).
  - Right edge: scope chip (e.g., `Manager · Northeast`) + 28px circular avatar `bg-primary text-white`.
- **Admin sub-nav** — only renders when `route` starts with `admin`. 40px tall, `bg-surface-alt`, top-bordered. Pills for Tenants / Users / Mappings / Goals / Pipelines, each with a 13px icon. Active pill gets `bg-surface border border-border`.

### 3. Dashboard (`route: "dashboard"`)

- Page header: `font-display text-3xl` "Dashboard", muted sub *"Live from gold tables. Filters apply to all panels below."*, `FilterBar` right-aligned (Range + Channel selects).
- `AccountToggle` (All / HCP / HCO segmented control above the KPI grid).
- 3-column KPI grid (`KpiCard` × 3).
- "Calls per week" card with embedded `TrendChart` (SVG, 800×240, dashed gridlines, gold area fill at 35→0% alpha, 2px gold stroke).
- "HCPs to re-engage" — `SignalsPanel` with severity-icon-tile rows (alert / warning / info), chevron right on each.
- 2-column row: "Top reps" + "Top HCPs" `DataTable`s.
- Power BI embed placeholder — dashed-border box, muted copy.

### 4. Inbox (`route: "inbox"`)

- h1 + count line ("X items need attention").
- `Briefing` card — sparkles icon + `BRIEFING` eyebrow in `--color-accent`, body in body-sized text.
- N `SignalsPanel`s, one per signal category.

### 5. HCP detail (`route: "hcp"`)

- Back-link `← Dashboard` (12px, ink-muted).
- Entity header: `font-display text-3xl` name + meta line *"MD • Cardiology • Boston, MA • NPI ..."* + chip row (Tier A in accent, Prescriber/KOL/Speaker in neutral).
- Same KPI / Trend / DataTable cadence as Dashboard, but scoped.

### 6. Rep detail (`route: "rep"`)

- Mirror of HCP detail with rep-specific copy. Includes its own AccountToggle so a manager can flip the rep's stats between HCP and HCO.

### 7. Admin → Tenants (`route: "admin"`)

- Create-tenant form (slug + name → PrimaryButton).
- Tenants table with status as accent chip (`active` = accent, `onboarding` = neutral).

### 8. Admin → Users (`route: "admin/users"`)

- "Invite from Veeva" table (Rep / Email / Status / Action) — primary path.
- "Manual invite" `<details>` escape hatch with email + role select + Send invite button.
- "Provisioned users" table (Email / Tenant / Role / Veeva user_key / Updated) — `tenant_user` mirror.

### 9. Admin → Mappings (`route: "admin/mappings"`)

- Bulk CSV upload card (Download template + Upload CSV).
- Propagate-pipeline trigger card with last-run line + "Run pipeline" button.
- "Needs mapping" table (Distributor ID / Account / Rows / Net gross $ / Last seen / Action). Right-pinned `Map →` link per row.
- "Saved mappings" table (Distributor ID / Veeva account / Type chip / Mapped by / When).

### 10. Admin → Goals (`route: "admin/goals"`)

- Filter card: Period type / Period / Metric selects.
- Goals card: column header includes Save button, table has Rep / Title / Recommended / Method / **editable Goal input** (mono, right-aligned, defaults to Recommended).
- Bulk CSV card at bottom.

### 11. Admin → Pipelines (`route: "admin/pipelines"`)

- 2×2 grid of `PipelineSummary` cards (Incremental refresh GLOBAL, Weekly full refresh GLOBAL, Delta maintenance GLOBAL, Mapping propagate TENANT). Each card: title + description, scope eyebrow, last-run/last-success lines with `StatusBadge`.
- "Recent runs" table (Pipeline / Scope / Status badge / Started / Duration / By / Detail).

## Interactions & Behavior

- **Routing** — single `useState` for `route`. Internal `<a onClick={() => go(...)}>` links only; no real router. Map onto Next.js App Router (`app/(app)/...`) on integration.
- **Active state for main nav** — `key === route` OR (`key === "admin"` and `route.startsWith("admin")`) OR (`key === "dashboard"` and route is `"hcp"`/`"rep"`).
- **Hover** — `transition-colors`-style swaps; rows use `bg-surface-alt`. No shadows, no scale.
- **Severity icons** — alert = AlertTriangle in `--color-negative`, warning = Clock in `--color-accent`, info = MapPin in `--color-primary`. Each sits in a 24×24 `bg-surface-alt` rounded-md tile.
- **Animations** — none beyond ≤200ms color/background transitions.
- **Forms** — focus ring is `box-shadow: 0 0 0 2px var(--color-primary)` on inputs/selects.

## State Management

In production this maps to React Server Components in Next.js:
- `route` → URL pathname (no client state needed).
- `filters` (range / channel / account) → search params, `useSearchParams` + `<Link>` updates.
- Goals form → server actions; rows are `dirty` if input differs from `existing_value`. See `apps/web/app/(app)/admin/goals/goals-form.tsx`.
- Tweaks panel state is **demo-only** — do not ship.

## Design Tokens (verbatim from `colors_and_type.css`)

### Colors
| Token | Hex |
|---|---|
| `--color-background` | `#FAFAF7` |
| `--color-surface` | `#FFFFFF` |
| `--color-surface-alt` | `#F3F2EE` |
| `--color-ink` | `#1C1B19` |
| `--color-ink-muted` | `#5A564E` |
| `--color-primary` | `#1F4E46` |
| `--color-primary-hover` | `#173A33` |
| `--color-accent` | `#C89B4A` |
| `--color-positive` | `#3D8B5E` |
| `--color-negative` | `#B24545` |
| `--color-border` | `#E5E3DB` |

### Typography
- Display: `DM Serif Display` (400 only) — h1, KPI numbers, hero
- Body: `DM Sans` (400/500/600/700) — running text, UI chrome
- Mono: `JetBrains Mono` — IDs, NPIs, env vars, counts in tables
- Scale: 12 / 14 / 16 / 18 / 20 / 24 / 30 / 48 / 60 px

### Radius
- 4px chips · 6px buttons/inputs · 8px cards (dominant) · 9999 pills
- **Never** > 8px on a container.

### Borders & elevation
- 1px `--color-border` hairline = the system's only elevation device.
- **No shadows. No gradients** (sole exception: trend-chart area fill).

### Spacing
- `space-y-6` between page sections, `p-5` inside cards, `px-5 py-4` for card headers, `gap-4` in card grids, `h-14 px-6` for nav.

## Iconography

The real codebase historically had **no icon system** (only severity dots + Unicode glyphs). This handoff **introduces a thin-line icon set** (lucide-style, 1.5px stroke, currentColor) — see `ui_kits/web/Icons.jsx`. Either:

- **Adopt it** as the canonical icon library going forward (recommended — rendered-from-SVG via `<Icon name="..." />`), or
- **Substitute Lucide** (`lucide-react`) with `strokeWidth={1.5}` — the kit was tuned to match Lucide's geometry exactly.

The icons used: `dashboard, inbox, reports, admin, settings, tenants, users, mappings, goals, pipelines, alertTri, clock, mapPin, sparkles, arrowLeft, arrowRight, externalLink, search, chevronDown`.

The `BrandMark` (3 wave lines + gold underline) in `Nav.jsx` is a **placeholder** — replace with the real mark once the brand is finalized.

## Content Fundamentals (must follow)

- Sentence case for everything except small UPPERCASE tracked eyebrows.
- No hype adjectives (no "powerful", "seamless", "unlock"). Name the mechanism, not the benefit.
- Em-dash (—) for asides, middle dot (·) for marketing separators, bullet dot (•) between facts on entity headers.
- Missing values render as `—`, never blank or `N/A`.
- Code/IDs/env vars in monospace inline.
- **No emoji.** Anywhere.
- Domain vocabulary: **HCP** (healthcare professional), **HCO** (healthcare organization), **rep** (field sales rep), **tenant** (customer pharma co.), **call** (logged Veeva interaction — not a phone call), **signal**, **briefing**, **scope**.

## Assets

- Fonts: Google Fonts (DM Sans, DM Serif Display, JetBrains Mono) — already imported at the top of `colors_and_type.css`.
- No bundled imagery. The Power BI embed is an iframe owned by `app-owns-data` service principal.
- Logo: typographic only. No symbol/mark exists in the repo. The braided BrandMark in this kit is a placeholder.

## Recommended next steps for the developer

1. Diff the kit's admin pages against `apps/web/app/(app)/admin/*/page.tsx` — most logic is already there; the kit captures only visual decisions.
2. Decide whether to adopt the Icon set (`Icons.jsx`) or pull Lucide. Either way, ship icons in the main nav + admin sub-nav + signals-panel.
3. Drop `Mappings` from the top-level `app-nav.tsx` and add the Admin sub-nav row when on an admin route.
4. Build out `Reports` and `Settings` (currently "Coming soon" stubs in the kit).
5. Replace the `BrandMark` placeholder once the brand is named.

## Files

See the table at the top of this README. Open `ui_kits/web/index.html` directly in a browser to see all the screens — use the Tweaks panel (bottom-right toggle) to flip palettes / accents / wordmark.
