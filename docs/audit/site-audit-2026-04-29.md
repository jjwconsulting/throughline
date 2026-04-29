# Throughline site audit — 2026-04-29

**Scope:** comprehensive review of every user-facing surface in the
Next.js web app after a multi-week feature-breadth phase. Goal is
twofold: (1) capture the current state of every page in enough detail
that an engineer or designer can act without re-exploring the
codebase; (2) flag cross-cutting issues, density problems,
duplication, and inconsistencies for the upcoming consolidation pass.

**This document is a baseline + opinion piece, not a prescription.**
Each "Recommendations" section presents candidates ranked by impact;
the actual punch list (what we ship vs defer) is decided after this
audit lands.

**Status update — 2026-04-29 (post-audit cleanup pass):**
Several items have already been addressed by engineering. See §5 for
status markers. Items requiring design input are deferred until
Claude Design (or a human designer) reviews the `design-handoff-brief.md`.

**Intended audiences:**
- **Engineering:** consolidation work, code organization, deprecation
  candidates.
- **Design (Claude Design or human):** visual hierarchy, spacing,
  typography, color use, density, mobile, button/empty-state
  consistency. Per-page sections include a `Design notes` callout
  for items that need a designer's judgment specifically.

---

## 0. Product context (for reviewers new to the codebase)

Throughline is a multi-tenant commercial-analytics SaaS for life
sciences. Core users:

- **Sales reps** — visit physicians (HCPs) and institutions (HCOs);
  log calls in Veeva CRM. They live in their territory, think
  account-by-account, want moment-of-truth context.
- **Sales managers** — oversee a team of reps, monitor coverage,
  pace vs goals.
- **Admins (commercial ops, brand)** — manage data plumbing
  (mappings, goals, integrations, attributes), monitor pipeline
  health, configure tenant.
- **Bypass admins (us)** — multi-tenant support/debug role.

The data plane is Microsoft Fabric (Delta Lake, Direct Lake semantic
model). The web app is Next.js 16 App Router, light-themed Tailwind
v4. Reads come from gold tables (call activity, sales, scoring); state
edits go to Postgres (mappings, goals, tenant config) which is mirrored
to Fabric on a sync cycle. RLS is enforced at the loader layer.

Visible LLM surfaces today: dashboard synopsis, rep recommendations,
on-demand call brief, conversational analytics (`/ask`).

Visual identity: warm-cream palette (`#FAFAF7` background, `#1F4E46`
deep-green primary, `#C89B4A` warm-gold accent, `#3D8B5E` positive,
`#B24545` negative). Two fonts: DM Serif Display for headings, DM
Sans for body. Light theme only; no dark mode.

---

## 1. Information architecture

### Navigation surfaces

- **Top nav** (always visible): Dashboard, Inbox, Explore, Ask,
  Reports, Admin, Settings + Clerk user button.
- **Admin sub-nav** (only on `/admin/*`): Tenants, Users, Mappings,
  Attributes, Goals, Pipelines.
- **Filter bar** (variable): rendered on /dashboard, /explore,
  /reps/[user_key], /hcps/[hcp_key], /hcos/[hco_key]. Range,
  Granularity, Channel, Type (call kind), Territory.

### Route map

| Route | Audience | Cardinality |
|---|---|---|
| `/dashboard` | All roles | Tenant-wide entry point |
| `/inbox` | All roles | Tenant signals digest |
| `/explore` | All roles | Self-service pivot |
| `/ask` | All roles | LLM conversational |
| `/reports` + `/reports/[id]` | All roles | Power BI escape hatch |
| `/hcps/[hcp_key]` | All roles | Per-HCP detail |
| `/hcos/[hco_key]` | All roles | Per-HCO detail |
| `/reps/[user_key]` | Manager/admin (rep sees self) | Per-rep detail |
| `/admin/tenants` | Admin/bypass | Tenant CRUD |
| `/admin/users` | Admin/bypass | User invite + provisioning |
| `/admin/mappings` | Admin/bypass | Distributor → Veeva mapping |
| `/admin/attributes` | Admin/bypass | Tenant scoring config |
| `/admin/goals` | Admin/bypass | Per-period goal authoring |
| `/admin/pipelines` | Admin/bypass | Pipeline run health |
| `/settings` | All roles | Placeholder |

### IA observations

- The main nav order roughly follows daily usage frequency
  (Dashboard → Inbox → Explore for self-serve → Ask for ad-hoc →
  Reports for deep dive → Admin → Settings). Reasonable.
- **Detail pages (`/hcps/*`, `/hcos/*`, `/reps/*`) are NOT in the top
  nav** — they're only reachable by clicking through tables. This is
  correct since they're entity-scoped, but means a user who wants to
  jump to a known HCP has no global search affordance. Worth flagging.
- The Admin sub-nav is well-organized but currently shows 6 tabs;
  another 1-2 will fit before it gets crowded.
- `/settings` is a placeholder ("Coming soon"). Either build it or
  hide the nav link until ready — currently looks broken to a
  first-time user.

### Cross-cutting nav recommendations

- **Add a global entity search** — "Jump to HCP / HCO / Rep" omnibox
  in the top nav. Currently the only path to a detail page is
  scrolling a list. A power user will want Cmd+K.
- **Hide /settings from nav** until it has content. Or replace with
  a single "Profile" link to Clerk's user menu.

---

## 2. Per-page audit

### 2.1 `/dashboard`

**Audience:** all roles (RLS scopes the data per role).
**Purpose:** "what happened recently across my visible scope, what's
trending, what needs attention."

#### Layout (top to bottom)

1. **Header** — `<h1>Dashboard</h1>` + one-line subtitle ("Live from
   gold tables. Filters apply to all panels below.") + FilterBar.
2. **SynopsisCard** *(LLM, conditional)* — "Since your last visit"
   short narrative, dismiss button.
3. **AccountToggle** — All / HCP / HCO segmented control.
4. **KPI cards** — 4 cards in a 4-col grid: Interactions, HCPs/HCOs
   reached, Active reps, Net units. Each shows headline + sub-line
   (attainment / vs-prior delta / live-vs-dropoff split / dollars).
5. **Calls trend chart** — TrendChart with goal-pace overlay.
6. **Net units trend chart** — TrendChart with goal-pace overlay,
   plus an "X unmapped distributors →" link in the header when present.
7. **SignalsPanel** — "HCPs to re-engage" (HCP inactivity signals).
8. **HCP tier coverage table** *(conditional)* — Tier × total ×
   contacted × no-activity × % contacted.
9. **Team rollup table** *(conditional, manager/admin only)* — per-rep
   calls + units attainment, sortable, drill-into-rep.
10. **Top reps + Top HCPs/HCOs** — 2-column grid (each is a small
    table).
11. **Top HCOs by Units table** *(conditional)*.
12. **Top reps by Units table** *(conditional)*.
13. **Top rising + Top declining accounts** — 2-column grid (each a
    table). Conditional on data presence.
14. **Watch list table** *(conditional)*.
15. **New accounts table** *(conditional)*.
16. **Top distributors (unmapped) table** *(conditional)* — with a
    "Map distributors →" link.
17. **PowerBI footer link** — "Need deeper analysis? Open the full
    Power BI report →"

#### Data sources

`loadInteractionKpis`, `loadTrend`, `loadTopReps`, `loadTopHcps`,
`loadTopHcos`, `loadHcpInactivitySignals`, `loadTierCoverage`,
`loadTeamRollup`, `loadDashboardSynopsis`, `loadSalesKpis`,
`loadSalesTrend`, `loadTopUnmappedDistributors`,
`loadTopHcosBySales`, `loadTopRepsBySales`, `loadAccountMotion`
(rising + declining), `loadWatchListAccounts`, `loadNewAccounts`,
`loadOverlappingGoalSum` (calls + units), `loadAccessibleTerritories`,
`loadRepCurrentTerritoryKeys`. Plus shared infra: `getCurrentScope`,
`scopeToSql`.

**Observation:** ~20 parallel loaders in `Promise.all`. Verify
total page latency on production-scale data; plan caching strategy
if it gets sluggish.

#### Issues

**Density (high impact):**
- 11+ vertical sections on a fully-populated tenant. Even with
  conditional rendering, this is a long scroll for an entry point.
- Two trend charts back-to-back (calls + units) — visually
  redundant treatment for two related-but-distinct metrics.
- Four "Top X" tables: Top reps (calls), Top HCPs/HCOs (calls), Top
  HCOs by Units, Top reps by Units. Partial duplication between the
  calls and units versions. The user has to mentally cross-reference.
- Account motion is FOUR separate tables: rising, declining, watch,
  new. They answer the same kind of question ("what's changing in
  the book?") and could be tabs of one panel.

**Duplication:**
- Same metrics surface in both trend chart sub-line AND KPI card
  sub-line.
- "Active reps" KPI card vs the Team rollup table when both render.
- Top HCO/Top rep by units could be merged with the Account motion
  panel if reframed (top performers + biggest movers in one panel).

**Empty-state inconsistency:**
- Some sections hide entirely on empty (`{tierCoverage.length > 0 ? …`),
  others show "No declining accounts in this window." inline, others
  have headers always but show a centered muted message inside.
- Tier coverage hides the whole panel; rising/declining keeps the
  header and shows a mid-card empty state. Two different conventions
  on the same page.

**Information hierarchy:**
- The synopsis card is conditionally rendered above the KPI cards
  (priority signal), but everything else is uniformly weighted. No
  visual indication that "Watch list" needs more attention than "Top
  reps." A designer might want to introduce some hierarchy via
  card size, color emphasis, or grouping.

**Other:**
- Goal attainment + delta + live-vs-dropoff sub-line on Interactions
  KPI gets concatenated to long single-line text ("98% of goal · -3%
  vs prior period · 4,732 live · 699 drop-off"). Small font, hard
  to scan.
- "Need deeper analysis?" PBI link buried at the bottom — easily
  missed.

#### Design notes

- **Hierarchy:** dashboard would benefit from explicit sections
  ("Today" / "This period" / "Trends" / "Things to act on" / "Health
  of data"). Currently it's a flat scroll with cards of equal
  weight.
- **Typography:** all section headers are `font-display text-lg` —
  no visual sub-hierarchy between primary sections (KPIs, trends)
  and secondary (top tables).
- **Color:** positive/negative used consistently (green/red) for
  metrics. Worth checking that the warm-gold accent isn't overused
  next to the deep-green primary.
- **Density:** consider collapsible sections by default with first
  N expanded, OR a left-rail sidebar that lets users jump.

#### Recommendations (by priority)

1. **Consolidate Account Motion into one tabbed panel** (Rising /
   Declining / Watch / New). One header, four tabs. Cuts 3 cards
   from the page.
2. **Merge Top HCOs by calls + Top HCOs by units** into one panel
   with metric toggle. Same for Top reps. Cuts 2 cards.
3. **Standardize empty-state behavior**: pick one (always show with
   "no data" message inside, OR hide entirely) and apply globally.
4. **Move PBI deep-link to header** (top-right, near FilterBar) so
   it's discoverable.
5. **Trim KPI sub-line concatenation** — pick one secondary signal
   per card based on what's most decision-useful in context.
6. **(Design) Establish section hierarchy** — visual grouping of
   related panels with subtle background differentiation or section
   headers.

---

### 2.2 `/hcps/[hcp_key]`

**Audience:** all roles (entity-scoped; data filtered by viewer's RLS).
**Purpose:** "everything I need to know about this physician, what's
changed, how to engage."

#### Layout (top to bottom)

1. **Header** — back link to /dashboard, name (h1), subtitle
   (credentials · specialty · city, state · NPI), tier + flag badges
   (Prescriber, KOL, Speaker), FilterBar.
2. **HcpSnapshotCard** — 4-stat panel: Targeting score (composite),
   Engagement (Hot/Active/Lapsed/Cold), Top scope, Parent HCO. Action
   toolbar top-right: Open in Veeva (always), Generate call brief
   (rep viewers only).
3. **SinceLastVisitCard** — adaptive header ("Since your last visit"
   for reps with prior call, "Recent activity" for everyone else).
   Sub-card list: parent HCO sales motion, first-ever-sale flag,
   other reps' calls.
4. **KPI cards** — 3 cards in a 3-col grid: Interactions, Reps
   engaged, Last contact.
5. **TargetScoreCard ("Score breakdown")** — per-therapy-area bars +
   top contributors footer. Renders only when scoring data exists.
6. **PeerCohortCard ("Compared to similar HCPs")** *(conditional)* —
   cohort definition, this HCP vs cohort median, channel mix bars,
   rising-prescribing subset comparison, correlation caveat footer.
7. **Calls trend chart** — TrendChart, scoped to this HCP.
8. **Reps who've called** — table by rep with call count + last call.

#### Data sources

`loadHcp`, `loadInteractionKpis`, `loadTrend`,
`loadHcpCallingReps` (page-local), `loadAllScoresForHcp`,
`loadSinceLastVisit`, `loadPeerCohort`, `loadLastCallEver`,
plus a Postgres lookup for `tenantVeeva.vaultDomain`. Shared infra:
`getCurrentScope`, `scopeToSql`, `combineScopes`, `hcpScope`.

#### Issues

**Density (high):**
- 7+ cards on a page that's a one-physician detail. Feels
  overstuffed once peer cohort + score breakdown both populate.
- Snapshot + KPI cards both have a "Last contact / Engagement"
  metric (different framings of same fact).
- SinceLastVisit's "Other reps who've called" partially overlaps
  with the bottom "Reps who've called" table — different time
  windows but both surface the same kind of fact.

**Conceptual overlap:**
- Snapshot's Engagement, KPI card's Last contact, and
  SinceLastVisit's anchor metadata all derive from `last_call_date`.
  Three different presentations of the same data fragment.
- TargetScoreCard's "Composite" headline (was removed) is now in
  Snapshot — but the breakdown card's per-scope bars and the
  Snapshot's "Top scope" stat both compete for the rep's eye on
  "what's the angle."
- PeerCohortCard's channel mix overlaps with what the (not-yet-built)
  /dashboard call-channel panel could show for the same cohort.

**Render-order question:**
- Snapshot is the "executive summary" — good placement at top.
- SinceLastVisit is anchored on rep mental model — worth being
  prominent for reps but is less useful for admin viewers.
- KPI cards now feel less load-bearing now that Snapshot owns the
  headline metrics. Could probably shrink them or subsume them into
  Snapshot.

**Other:**
- The header tier badge uses accent color; the Snapshot's parent-HCO
  tier subtitle is plain text. Consistency drift.
- Many "Specialty" displays — appears in subtitle, KPI sub-text,
  PeerCohort definition — slight repetition.
- Trend chart and "Reps who've called" table are at the bottom and
  feel like the original page (pre-snapshot, pre-since, pre-cohort).

#### Design notes

- **Page is now feature-rich but visually disorganized** — could
  benefit from a 2-column layout above the fold (Snapshot left +
  SinceLastVisit right, both compact) with the rest stacked.
- **The "Engagement" stat in Snapshot** uses a colored Hot/Active/
  Lapsed/Cold label. Worth verifying these treatments work in
  isolation and don't conflict with the tier badges nearby.
- **Score breakdown bars and Peer cohort bars** use different visual
  treatments for similar concepts (per-attribute score bars vs
  cohort channel mix bars). Could converge on one bar style.
- **The action toolbar in Snapshot** (Open in Veeva + Generate brief)
  uses a primary blue button + a secondary outlined button. Verify
  visual weight — Generate brief is the more decision-useful action;
  Open in Veeva is a navigation aid.

#### Recommendations

1. **Consolidate Snapshot + KPI cards** — current KPI metrics
   (Interactions, Reps engaged, Last contact) could become smaller
   stats or move into Snapshot. The 3-card row feels redundant after
   Snapshot.
2. **Merge SinceLastVisit's "Other reps' calls" with the bottom
   "Reps who've called" table** into a single timeline/list with
   a window toggle.
3. **Score breakdown becomes a tab/expander on Snapshot** — only
   power users want the full per-scope breakdown; most just want
   the headline (already in Snapshot).
4. **Move PeerCohort into a "Comparisons" expander** — it's
   informational, not actionable for most calls.

---

### 2.3 `/hcos/[hco_key]`

**Audience:** all roles.
**Purpose:** "what's happening at this institution, who's there,
how's the rep coverage."

#### Layout (top to bottom)

1. **Header** — back link to /dashboard, name (h1), subtitle
   (hco_type · account_group · city, state · bed_count), Veeva ID
   line, tier + segmentation + hospital_type badges, action toolbar
   (Open in Veeva), FilterBar.
2. **KPI cards** — 3 or 4 cards depending on `hasSalesHistory`:
   Interactions, Reps engaged, Last contact, optional Net units.
3. **Calls trend chart** — TrendChart scoped to this HCO.
4. **AffiliatedHcpScoresCard** *(conditional)* — top affiliated
   HCPs at this HCO ranked by composite score. Score column,
   HCP link, specialty, tier, top contributors, last call (with
   "Never called" red emphasis).
5. **Net units trend chart** *(conditional on sales)* — TrendChart
   for sales motion at this HCO.
6. **Top products table** *(conditional on sales)* — top products
   by units in period.
7. **Sales attribution table** — every territory bridged to this
   HCO with primary flag, current rep, assignment source,
   manual-vs-rule. Includes a "How primary is picked" + "To change"
   admin-y footer.
8. **Reps who've called** — table by rep with call count + last call.

#### Data sources

`loadHco`, `loadInteractionKpis`, `loadTrend`,
`loadHcoCallingReps`, `loadHcoSalesKpis`, `loadHcoSalesTrend`,
`loadHcoTopProducts`, `loadHcoAttributionChain`,
`loadTopScoringAffiliatedHcps`, plus Postgres
`tenantVeeva.vaultDomain` lookup.

#### Issues

**No HCP-style snapshot card** — HCP page got a top-of-page snapshot
but HCO page hasn't been updated to match. Inconsistent treatment of
sibling entity types.

**Sales attribution table is admin-focused but visible to all roles**
— the "How primary is picked" + "To change in Veeva" footer reads as
admin documentation. Reps don't care; they just want to know "who
covers this." Worth scoping or simplifying for non-admin viewers.

**Two trend charts (calls + sales) again** — same concern as
dashboard, but here it's per-HCO.

**Top products table** is great context but only renders with sales
history; on a calls-only HCO the page feels thin.

#### Design notes

- **Lacks parity with HCP page** — should get a similar
  HcoSnapshotCard at top: composite institution score (when we have
  HCO scoring), aggregate engagement, top affiliated HCPs preview,
  primary rep + Veeva link.
- **Sales attribution footer** could become a "?" tooltip rather
  than always-visible paragraph block.
- **Action toolbar placement** — Open in Veeva button is in the
  header next to FilterBar; HCP snapshot has it inside the snapshot
  card. Convention divergence.

#### Recommendations

1. **Add an HcoSnapshotCard** mirroring HCP page treatment. Same
   4-stat grid: Coverage status, Sales motion, Top affiliated HCP,
   Primary rep.
2. **Demote sales attribution detail behind a "View attribution
   details" expander.** Show "Primary rep: [Name]" prominently;
   put the rest behind disclosure.
3. **Standardize action button placement** with HCP page — either
   both in snapshot or both in header, not split.
4. **Add a SinceLastVisit-equivalent panel** — "Activity at this
   HCO" panel with sales motion + recent reps' calls would mirror
   what HCP page has. Currently you have to read the trend + the
   calling-reps table separately.

---

### 2.4 `/reps/[user_key]`

**Audience:** rep (sees self), manager (sees team), admin/bypass (sees all).
**Purpose:** "what's this rep doing, what's their pace, who should
they call this week."

#### Layout (top to bottom)

1. **Header** — back link to /dashboard, name (h1), subtitle (title ·
   department · user_type · status), FilterBar.
2. **AccountToggle** + **KPI cards** — 3 or 4 cards: Interactions,
   HCPs reached, Last call, optional Net units.
3. **RepRecommendationsCard** *(LLM, conditional)* — "Suggested this
   week" 3-5 prioritized HCP/HCO with severity badges, expand for
   context (affiliated HCPs / sales mini-trend / recent calls) +
   action launchpad (Open in Veeva, Generate call brief).
4. **Calls trend chart** — TrendChart with goal-pace overlay.
5. **Net units trend chart** *(conditional)* — TrendChart with goal
   overlay.
6. **Top HCOs by Units** *(conditional)* — table.
7. **Coverage HCOs** *(conditional)* — full list of bridged HCOs
   with Primary / Co-coverage badge, location, territories covered.
8. **SignalsPanel** — "HCPs to re-engage" scoped to this rep.
9. **Top HCPs called** — table by call count.

#### Data sources

`loadRep`, `loadInteractionKpis`, `loadTrend`, `loadTopHcps`,
`loadHcpInactivitySignals`, `loadOverlappingGoalSum` (calls + units),
`loadRepCurrentTerritoryKeys`, `loadRepSalesKpis`,
`loadRepSalesTrend`, `loadRepTopHcos`, `loadRepCoverageHcos`,
`loadRepRecommendations`, `loadRecommendationContexts`,
`loadVeevaAccountIdsForItems`, plus Postgres `tenantVeeva` lookup.

#### Issues

**Density (high):**
- 8+ cards on a page that's also dense. Two trend charts again.
- ✅ Coverage HCOs (RESOLVED 2026-04-29) — was a 200+ row wall;
  now uses the long-list pattern (default-truncate top 20 + search +
  show-all). See `coverage-hcos-table.tsx` and `ui-patterns.md`.
- Top HCOs by Units + Coverage HCOs both list HCOs. Different cuts
  but visual repetition.

**Missing equivalent of HCP-page Snapshot:** the rep page doesn't
have a top-of-page consolidated stat row. The KPI cards are roughly
this shape but lack the visual treatment (score, engagement status,
parent organization equivalent — maybe "primary territory" or
"team").

**Recommendations card is the most important section** but it's
buried below KPI cards. For a rep landing on their own page, the
recommendations are the highest-value first read.

**Page heavily mixes calls + sales context** — alternates calls →
sales → calls again. A rep who only cares about one or the other
has to scroll past everything.

#### Design notes

- **A RepSnapshotCard** mirroring HCP/HCO would be valuable: rep
  pace (calls + units attainment), territories covered, last call
  date, headcount of HCPs in coverage, total open-targets count.
- ✅ Coverage HCOs long-table problem (RESOLVED 2026-04-29) — now
  uses the long-list pattern with search + truncate.
- **Two trend charts back-to-back** — same observation as dashboard.
- **Verify recommendation card visual prominence** — the "Suggested
  this week" card should feel like the headline action area,
  visually weightier than tables below.

#### Recommendations

1. **Promote recommendations above KPI cards** — for rep viewers,
   "what should I do this week" beats "what did I do last week."
2. **Add a RepSnapshotCard** — pace, attainment, territory count,
   coverage size, key flag (e.g. "behind pace").
3. ✅ Coverage HCOs density (RESOLVED 2026-04-29) — addressed via
   long-list pattern (search + truncate + show-all) rather than
   tabification, which is a lighter intervention with the same
   value.
4. **Consolidate two trend charts** into a switchable single chart
   (Calls vs Net units toggle), saving vertical space.

---

### 2.5 `/explore`

**Audience:** all roles, primarily admins + analytical users.
**Purpose:** "let me pivot any dimension against any metric and
slice by time."

#### Layout (top to bottom)

1. **Header** — back link, h1, one-line subtitle, FilterBar.
2. **Matrix card** with embedded title + MatrixPickers control row
   + the MatrixTable itself. Single big card, no other panels.

#### Data sources

`loadGenericMatrix`, `loadAccessibleTerritories`. Registry:
`ROW_DIMS`, `METRICS`, `dimById`, `metricById`.

#### Issues

- **Single-purpose page, well-scoped** — much cleaner than other
  pages. No density problems.
- **Pickers placement** is in the matrix card header, which works
  but means they're easy to miss when first landing on the page.
  A user might not realize they can change the pivot.
- **Empty / unsupported state** is well-handled with explanatory
  text.
- **No saved-view / bookmarkable named view** mechanism — URL state
  is shareable, which is great, but no UI to "save this view"
  explicitly.

#### Design notes

- **Pickers could be more visually prominent** — maybe a sidebar
  or a header strip above the matrix.
- The rendered matrix is wide; mobile experience hasn't been
  verified.
- Heatmap shading + monospace numbers — verify legibility.

#### Recommendations

1. **Promote the picker controls visually** — separate row above
   the matrix with bigger labels.
2. **Add saved views** — let users save a named pivot
   configuration. Power-user feature; defer until requested.
3. **Verify mobile/responsive** — matrices with many columns may
   overflow.

---

### 2.6 `/inbox`

**Audience:** all roles.
**Purpose:** "what needs my attention right now across all
signal types."

#### Layout

1. Header: title + status ("X items need attention" / "All clear").
2. Conditional synopsis brief (only when signals exist).
3. Grouped signal panels by category (alert, warning, info).

#### Data sources

`loadAllSignals`, `getCurrentScope`, `scopeToSql`.

#### Issues

- **Single-purpose, well-scoped** — clean page.
- **Signal types are color-coded by severity** (alert/warning/info)
  — verify the palette is consistent with the dashboard +
  detail pages (red/amber/blue vs the app's red/gold/green palette).
- **No "mark as read" / "snooze" affordance** — signals stay until
  the underlying condition resolves. That's correct for v1 but
  worth noting; eventually reps will want to dismiss noise.

#### Design notes

- Signals palette should align with the cross-app positive/
  negative/accent colors. Re-verify.

#### Recommendations

1. **(Defer)** Add per-signal dismiss / snooze when noise becomes
   a complaint.
2. **Verify color palette** matches global tokens.

---

### 2.7 `/ask`

**Audience:** all roles.
**Purpose:** ad-hoc natural-language analytics questions.

#### Layout

1. Header: title + back link.
2. ChatThread component (full-height chat UI).

#### Data sources

`getCurrentScope`, `sendChatMessageAction` (server action). 8 tools
registered (`query_top_accounts`, `query_account_motion`,
`lookup_entity`, `lookup_territory`, `query_rep_summary`,
`query_tier_coverage`, `query_entity_detail`, `query_goal_attainment`).

#### Issues

- **Conversations don't persist** — refresh = new conversation.
  No history. No "saved chats" or "share this answer."
- **Tool pills are inline collapsed** — visible for trust but
  expandable for detail. Good pattern.
- **Suggested prompts on empty state** — 4 starter prompts. Worth
  reviewing whether they cover the questions users ACTUALLY ask
  (we have logs; could iterate).

#### Design notes

- Chat bubble alignment (user right, assistant left) is standard.
- Tool pill visual style — verify it doesn't compete with content.
- No multi-line input — the textarea may be too small for complex
  queries.

#### Recommendations

1. **Add lightweight conversation history** — at minimum, list of
   prior prompts in this session that user can re-click.
2. **Iterate suggested prompts** based on actual usage logs.
3. **(Long-term)** Persist conversations across sessions for
   power users.

---

### 2.8 Admin surfaces (`/admin/*`)

All six admin pages share a common pattern: page header → form (where
applicable) → table of existing config → admin-y context footer.
They use the same card vocabulary as the rest of the app.

#### `/admin/tenants` — tenant CRUD (admin landing)
Standard form + table. Status badges. Empty state. **No issues.**

#### `/admin/users` — invite flow
Two-section page: Veeva-rep invite table + manual invite form
(collapsed via `<details>`). Provisioned users table at bottom.
Manual invite is de-emphasized — correct for the primary path.

#### `/admin/mappings` — distributor → Veeva
Most workflow-heavy admin page. CSV import + pipeline trigger +
unmapped table with autocomplete suggestions + saved mappings list.

**Issue:** the page handles a lot. The pipeline-status panel + CSV
upload + per-row mapping + saved list could be split into tabs.

#### `/admin/attributes` — tenant scoring config
Phase-1 config UI. Form with cascading bronze pickers + table of
existing mappings + Phase 2 follow-up info box. Clean.

**Issue:** Phase 2 info box is informational ("not yet built");
when Phase 2 lands, that should be removed. Tracked.

#### `/admin/goals` — period goal authoring
Period picker + goals form with recommendations + bulk CSV.
Recommendation rationale text is great context.

**Issue:** rationale text can get long; consider tooltip or
expander.

#### `/admin/pipelines` — pipeline health
Summary cards (one per kind) + recent runs table with expandable
detail. Expandable `<details>` for step metrics + errors.

**Issue:** mixed conventions — summary cards use status badges
(visual), table rows use text status. Consistency drift.

#### Cross-cutting admin recommendations

1. **Standardize status badge usage** across all admin pages —
   colors, shape, copy.
2. **Standardize form-on-top + table-below pattern** — all admin
   pages roughly do this; verify spacing, header treatment is
   consistent.
3. **Add "?" tooltips** for technical jargon (e.g. "primary
   territory," "attribution status," "step metrics").
4. **Consider per-page intro text consistency** — some pages have
   a one-line subtitle, others have a paragraph. Pick a default.

---

### 2.9 `/reports` + `/reports/[id]`

**Purpose:** Power BI deep-dive escape hatch.

Index page lists available reports as cards (1 col mobile, 2 col
desktop). Detail page embeds the iframe.

#### Issues

- **Empty state** ("Set POWERBI_REPORT_ID in .env.local") leaks
  implementation detail to the user. Should be a friendlier message
  like "No reports configured yet — contact your admin."
- **Embed iframe** — verify height handling, mobile responsiveness.
- **No filtering / search** on the index — fine for 2-3 reports;
  reconsider when there are 10+.

---

### 2.10 `/settings`

Placeholder. **Recommendation: hide nav link until implemented OR
populate with at least the Clerk profile management link as a
minimum viable surface.**

---

## 3. Cross-cutting analysis

### 3.1 Visual language

**Card pattern (used everywhere):**
```
rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]
```
Excellent consistency. Every panel uses this. **Don't break it.**

**Header pattern (within cards):**
```
px-5 py-4 border-b border-[var(--color-border)]
  <h2 className="font-display text-lg">Title</h2>
  <p className="text-xs text-[var(--color-ink-muted)]">Subtitle</p>
```
Consistent across most cards. Some cards use `flex items-baseline
justify-between` for header + action button, others omit. Worth
standardizing.

**Table pattern:**
```
className="w-full text-sm"
thead: text-xs text-ink-muted
tbody rows: border-t border-border hover:bg-surface-alt
```
Consistent. Numeric columns use `text-right font-mono`. Good.

**KPI card pattern:**
```
rounded-lg bg-surface border-border p-5
  <p className="text-sm text-ink-muted">Label</p>
  <p className="font-display text-3xl mt-2">Value</p>
  <p className="text-xs text-ink-muted mt-1">Sub-line</p>
```
Consistent. Repeated 4-5 times across pages.

**Action button patterns:**
- Primary (link-out, e.g. Open in Veeva):
  `bg-primary text-white text-xs rounded-md px-3 py-1.5`
- Secondary (in-app action):
  `bg-surface text-ink border-border text-xs rounded-md px-3 py-1.5`
- Submit (forms):
  `bg-primary text-white text-sm rounded-md px-4 py-2`
- Inline link:
  `text-xs text-primary hover:underline`

**Inconsistency:** primary buttons are sometimes `text-xs` (icon-bar
buttons) and sometimes `text-sm` (forms). Could standardize to
two variants: "compact" and "default."

### 3.2 Color usage audit

**Cross-app:**
- `var(--color-positive)` (green): rising metrics, attainment ≥ 90%,
  Hot engagement, "Live" call counts.
- `var(--color-negative)` (red): declining metrics, attainment < 70%,
  Lapsed engagement, never-called HCPs.
- `var(--color-accent)` (warm gold): mid-tier (50-79%), Active
  engagement, tier badge background.
- `var(--color-ink-muted)`: secondary text, table cell defaults
  for low-importance values.

**Consistent.** No obvious palette drift.

**Open question for design:** is the warm gold accent visually
distinct enough from the deep green primary? In bar charts both
appear as fills.

### 3.3 Typography

- `font-display` (DM Serif Display): h1, h2, KPI big numbers.
- `font-body` (DM Sans, default): body text, labels, table cells.
- `font-mono` (system mono): numeric table cells, timestamps,
  IDs.

**No sub-hierarchy between section headers** — h2 is `font-display
text-lg` everywhere, no h3 distinction. Pages with many sections
(dashboard) read flat as a result.

**Page titles** are `font-display text-3xl`, card titles `font-display
text-lg`. There's no in-between size for super-sections / page
sub-sections — adding one would help with the dashboard hierarchy
problem flagged above.

### 3.4 Empty states

**Three different patterns in use:**
1. Hide the card entirely when no data (`{rows.length > 0 ? <Card /> : null}`)
2. Render the card with a centered muted message inside
3. Render the card with a tbody row showing "No matches in this period"

**Inconsistent.** A user familiar with one page will be confused on
another. Pick one (probably #2 — show the card so users learn the
section exists, but make the empty state self-explanatory) and apply
globally.

### 3.5 Language consistency

**Already-flagged:** no tenant-language in user-facing UI (per
`feedback_no_tenant_language_in_ui` memory). Verify post-audit.

**Other patterns:**
- Period labels: "Last 12 weeks," "Quarter to date," etc. Consistent.
- "Calls" vs "Interactions" — used interchangeably. The KPI card
  says "Interactions" but trend chart says "Calls." Consider
  standardizing on one.
- "HCO" vs "Account" — mostly HCO, but a few admin pages say
  "Account." Reps know "HCO"; admins might know either.
- "Score" vs "Targeting score" vs "Composite score" — three
  different phrasings for the same number. Standardize.
- Tier labels: "Tier 1" / "Tier 2" / etc. and bare "1" / "2".
  Display is mostly "Tier N" — but Veeva data sometimes leaks raw
  values. Verify a normalizer.

### 3.6 LLM surface comparison

Four LLM-driven surfaces today. Architecture comparison:

| Surface | Cache key | Rate-limit | Model | Max tokens |
|---|---|---|---|---|
| Synopsis (`/dashboard`) | `(tenant, user, pipeline_run)` | 4h floor | sonnet-4-6 | varies |
| Recommendations (`/reps/*`) | `(tenant, rep, pipeline_run)` | 4h floor | sonnet-4-6 | 600 |
| Call brief (on-demand) | `(tenant, rep, entity_kind, entity_key, pipeline_run)` | 4h floor | sonnet-4-6 | 500 |
| `/ask` chat | None | None (per-message) | opus-4-7 | varies |

**Observations:**
- Three surfaces share the cache + rate-limit pattern. Good.
- Each has its own SYSTEM_PROMPT with similar boilerplate ("don't
  invent data," "cite specific facts," "output ONLY this JSON
  shape"). Some prompt drift between them — same intent, different
  wording.
- Each has its own input-gathering function with similar
  open-ended object shape. Good consistency in pattern, slight
  drift in field naming.
- The synopsis and recommendations both use a "future inputs"
  empty placeholder pattern (predictions, forecasts,
  call_intelligence). Call brief doesn't have explicit
  placeholders — could add for parity.
- All output JSON parsing is defensive (markdown-fence stripping,
  JSON braces extraction). Three near-identical `parseX` functions —
  could be unified.

#### Recommendations

1. **Extract a shared `extractJsonFromLlmOutput()` helper** — three
   near-duplicate parsers can collapse into one.
2. **Unify the system-prompt boilerplate** — extract a shared
   "core rules" preamble that all surfaces include, plus
   surface-specific instructions.
3. **Standardize input-gathering field naming** — "rep" / "viewer"
   / "scope" used inconsistently.
4. **Verify cache invalidation** is consistent across surfaces —
   pipeline_run is the main key, but each surface decides
   differently when to bust.

### 3.7 Density observations (page-level)

| Page | Vertical sections | Notes |
|---|---|---|
| /dashboard | 11+ | Largest. Audit candidate #1. |
| /reps/[user_key] | 8 | Dense. Audit candidate #2. |
| /hcps/[hcp_key] | 7+ | Dense. Recently grew. |
| /hcos/[hco_key] | 6-8 | Moderate; lacks snapshot card. |
| /admin/mappings | 4 | Workflow-heavy but bounded. |
| /admin/users | 3 | Reasonable. |
| /admin/goals | 3 | Reasonable. |
| /admin/pipelines | 3 | Reasonable. |
| /admin/attributes | 3 | Reasonable. |
| /admin/tenants | 2 | Light. |
| /explore | 1 | Single-purpose. Good. |
| /inbox | 1-3 | Bounded. |
| /ask | 1 | Single chat surface. |
| /reports | 1 | Light. |
| /settings | 0 | Placeholder. |

**Observation:** density correlates with surface age. Newer pages
(/explore, /ask, /admin/attributes) are tighter. Older ones
(/dashboard, /reps/*) accumulated cards over time without revisiting
hierarchy.

### 3.8 Mobile / responsive

**Not formally audited.** Tailwind grid classes (`grid-cols-1
md:grid-cols-2 lg:grid-cols-4`) suggest mobile-friendly intent at
the layout level, but:
- Wide tables (`/admin/mappings`, `/explore` matrix) will overflow.
  (Coverage HCOs is now compact via the long-list pattern.) on mobile
- Header rows with FilterBar + h1 use `flex-wrap` — should degrade
  gracefully but not verified
- Numeric columns + monospace fonts may look cramped at small sizes

**Recommendation:** dedicated mobile pass during the design review.

### 3.9 Performance

**No formal load testing.** Detail pages have many parallel queries
in `Promise.all` (HCP page now has 8+, dashboard has 20+). At
fennec scale (~78k HCPs, ~22k calls, ~25k HCOs) this may be fine;
at production scale (10x larger) it likely needs caching.

**Recommendation:** instrument page load times in production
telemetry; add caching layer (e.g. unstable_cache) for slow loaders
once we measure.

---

## 4. Engineering organization

### 4.1 Component inventory

```
components/
  app-shell.tsx               — top-level wrapper (good)
  app-nav.tsx                 — main nav (good)
  admin-sub-nav.tsx           — /admin/* secondary nav (good)
  brand-mark.tsx              — logo (good)
  nav-links.tsx               — nav link list (good)
  icon.tsx                    — icon helpers (good)
  signals-panel.tsx           — used 2 places
  synopsis-card.tsx           — used 1 place
  rep-recommendations-card.tsx — used 1 place (heavy)
  call-brief-button.tsx       — used 2 places (recently extracted)
  hcp-snapshot-card.tsx       — used 1 place
  since-last-visit-card.tsx   — used 1 place
  peer-cohort-card.tsx        — used 1 place
  target-score-card.tsx       — used 1 place
  affiliated-hcp-scores-card.tsx — used 1 place
  matrix-table.tsx            — used 1 place (/explore)
  chat-thread.tsx             — used 1 place (/ask)
```

**Observations:**
- Most cards are page-specific. That's fine; not every component
  needs to be reusable.
- `rep-recommendations-card.tsx` is large (~370 LOC) and contains
  multiple sub-components (HcoContext, HcpContext, AffiliatedHcpRow,
  SalesMiniTrend, ActionLaunchpad). Could split into separate files.
- The card pattern (border, header, body) is duplicated as
  inline JSX everywhere — could become a `<Card>` / `<CardHeader>`
  / `<CardBody>` component if we want to standardize.

### 4.2 Lib organization

```
lib/
  bronze-introspection.ts     — admin attribute pickers
  call-brief.ts               — LLM call brief module
  chat/                       — /ask chat machinery
  db.ts                       — Postgres client
  explore-registry.ts         — /explore dim/metric registry
  explore.ts                  — /explore loader
  fabric-jobs.ts              — Fabric pipeline trigger client
  fabric.ts                   — Fabric SQL endpoint client
  goal-lookup.ts              — period-overlapping goal sums
  goal-recommendations.ts     — goal pre-fill recommendations
  hcp-page-insights.ts        — Since-last-visit + peer cohort
  hcp-target-scores.ts        — gold.hcp_target_score loaders
  insight-brief.ts            — older brief module (?? possibly deprecated)
  interactions.ts             — gold.fact_call core loaders
  mapping-suggestions.ts      — fuzzy account matching
  powerbi.ts                  — PBI embed token minting
  rep-recommendations.ts      — LLM rep recommendations module
  sales.ts                    — gold.fact_sale core loaders (large)
  scope.ts                    — RLS resolution
  signals.ts                  — gold.fact_call signal generators
  string-similarity.ts        — Jaro-Winkler etc.
  synopsis.ts                 — LLM dashboard synopsis module
  team.ts                     — manager team rollup
  veeva-url.ts                — Veeva deep link builder
```

**Observations:**
- 24 lib files. Reasonable for the surface count.
- `insight-brief.ts` may be a precursor to `call-brief.ts` — verify
  it's not stale dead code. If unused, delete.
- `sales.ts` is large (~1300 LOC) — acceptable but worth checking
  if any subsections could split out (e.g. account motion vs core
  KPIs).
- LLM modules (`synopsis.ts`, `rep-recommendations.ts`,
  `call-brief.ts`) have similar shapes — see §3.6 for unification.

### 4.3 Stale code candidates (verify before deleting)

- `lib/insight-brief.ts` — probably superseded by `call-brief.ts`.
- Any unused exports from older surfaces.

### 4.4 Tests

**Zero coverage.** Highest-stakes code paths:
- Sales attribution (`gold_fact_sale_build` notebook + downstream
  loaders)
- LLM input shape + parsing (defensive parsers exist, untested)
- RLS scope resolution (`scope.ts`)
- Filter parsing + URL state (`filters.ts`)

**Recommendation:** start with these four areas. Vitest for the web
app; pytest for notebook shape verification.

---

## 5. Top 10 cross-cutting issues (prioritized punch list)

Status legend: ✅ shipped · ⏳ awaits design input · ⏸ deferred

1. ✅ **Standardize empty-state behavior** across all pages.
   Resolved 2026-04-29: italic muted-text pattern (`px-5 py-8 text-center
   text-sm text-ink-muted italic`) applied across all 16 surfaces.
   Documented in `docs/audit/ui-patterns.md`.
2. ⏳ **Establish a section-hierarchy for /dashboard** — group related
   panels into super-sections with visual differentiation.
   *Awaits design input on hierarchy treatment.*
3. ✅ **Consolidate Account Motion** (rising/declining/watch/new) into
   a single tabbed panel on /dashboard. Resolved 2026-04-29 via new
   `components/account-motion-panel.tsx` with URL-driven tabs. Cut
   3 cards from /dashboard, ~290 lines from `page.tsx`.
4. ✅ **Add HcoSnapshotCard** mirroring HCP page treatment.
   Resolved 2026-04-29 — `components/hco-snapshot-card.tsx`. Engagement /
   Sales motion / Primary rep / Top affiliated HCP. Open-in-Veeva
   moved into snapshot toolbar.
5. ✅ **Add RepSnapshotCard** mirroring HCP page treatment.
   Resolved 2026-04-29 — `components/rep-snapshot-card.tsx`. Calls
   attainment / Units attainment / Coverage / Engagement.
6. ✅ **Unify LLM surface boilerplate**. Resolved 2026-04-29 via new
   `lib/llm-utils.ts`: shared `parseLlmJson<T>()` defensive parser
   + `LLM_CORE_RULES` shared system-prompt preamble. Refactored into
   synopsis, rep-recommendations, call-brief.
7. ⏳ **Audit /hcps card overlap** — Snapshot owns headline;
   collapse KPI cards or merge into Snapshot.
   *Awaits design input on hierarchy + per-card weight.*
8. ⏳ **Extract a `<Card>` component** with `<CardHeader>` /
   `<CardBody>` slots. *Awaits design input on slot/variant API.*
9. ⏳ **Standardize action button variants** — define "primary,"
   "secondary," "ghost," "destructive" once and apply.
   *Awaits design input on button system.*
10. ⏸ **Mobile/responsive audit pass** — formally verify all pages
    on small viewports. *Separate audit; deferred.*

### Quick wins (shipped 2026-04-29)

- ✅ Hide `/settings` from nav until implemented.
- ✅ Move "Open the full Power BI report →" link from dashboard
  footer to header subtitle.
- ⏳ Add global Cmd+K entity search. *Awaits design input on IA.*
- ✅ Friendlier empty state on `/reports` (don't leak env var name).

### Longer-horizon (post-audit, customer-driven)

- Tests (zero coverage today).
- Per-tenant Veeva URL config (covered in
  `feedback_veeva_url_per_tenant`).
- Per-tenant rules registry (covered in
  `project_tenant_specific_rules_registry`).
- Email digest surface (covered in `project_v2_product_backlog`).

---

## 6. What this audit deliberately doesn't cover

- **Notebook-level data plane** — silver/gold builds, pipeline
  orchestration. Separate audit if needed.
- **Authentication/Clerk integration** — out of scope.
- **Performance benchmarking** — flagged but not measured.
- **Accessibility (a11y)** — flagged below; full audit is its own
  project.
- **Internationalization** — single-locale (en-US) today; not
  flagged for change.

### Accessibility callouts (high-level)

- All interactive elements use semantic HTML (`<button>`, `<a>`,
  `<select>`, `<form>`).
- No formal WCAG audit done; should pass automated tooling but
  may surface contrast issues with the warm-gold accent on certain
  surface backgrounds.
- Form labels are present (`<label>` wrap pattern in FilterBar).
- Tables don't use `<caption>` or scope attributes; could improve
  for screen readers.
- Loading/pending states use disabled buttons but no
  `aria-busy` / `aria-live` regions.

---

## 7. Cross-references

- `feedback_no_tenant_language_in_ui` — UI copy guidance
- `feedback_territory_display` — territory label preference
- `feedback_veeva_url_per_tenant` — per-tenant URL config TODO
- `project_post_buildout_audit_checklist` — running list of
  consolidation candidates (this doc supersedes it)
- `project_rep_buyin_thesis` — strategic positioning vs Veeva
- `project_llm_input_extensibility` — LLM consumption pattern
- `project_v2_product_backlog` — what's queued post-audit
- `docs/architecture/tenant-custom-attributes.md` — Phase 2 spec
- `docs/product/web-display-philosophy.md` — native-first rendering
  framing

---

## 8. Suggested next steps

1. **You (James) review this doc** — flag anything mischaracterized
   or anything that lands differently than I framed it.
2. **Hand off to Claude Design** (or human designer) for visual
   review focused on §1 (IA), §2 design notes, §3 (cross-cutting
   visual), §3.7 (density), §3.8 (mobile).
3. **Build a punch list** combining engineering recommendations
   (§5 top 10) with design recommendations (whatever comes back).
   Sequence by impact + effort.
4. **Consider this audit a checkpoint, not a freeze** — feature
   work can continue, but should be aware of the cross-cutting
   patterns flagged here so we don't widen the gaps.
