# Prompt for Claude Design

Copy-paste this whole block to Claude Design when handing off the
review. Adjust the `<placeholder>` bits for your context.

---

I need a structured design review of a working SaaS web app I've
been building. The app has just gone through a multi-week
feature-breadth phase + a cross-cutting engineering cleanup pass;
now I want a designer's eyes on the visual hierarchy, density,
component system, and consistency questions that engineering
deliberately punted to design.

## What you're reviewing

**Throughline** — a multi-tenant pharma commercial-analytics SaaS
web app. Light theme, warm-cream palette, two fonts (DM Serif
Display headers, DM Sans body). Audience: pharma sales reps,
managers, and admins (commercial ops). Built on Next.js 16 +
Tailwind v4 + CSS variables.

The app reads from a Microsoft Fabric data warehouse and surfaces
the data via native React dashboards (with embedded Power BI as an
escape hatch for deep analysis). It also has 4 LLM-driven surfaces
(synopsis card, rep recommendations, on-demand call brief,
conversational analytics).

## Your inputs

I'll attach two files. Read in this order:

1. **`design-handoff-brief.md`** — the primary input. Visual /
   UX-focused subset of the engineering audit, pre-prioritized with
   six numbered deliverables + smaller items + per-page render-order
   summary. Read this first.
2. **`ui-patterns.md`** — current visual system: color tokens,
   typography, card vocabulary, button variants, table pattern,
   empty-state pattern. Use as reference for the existing language.

A third file (`site-audit-2026-04-29.md`) exists if you want deeper
context on a specific page or engineering concern, but it's not
required reading. The handoff brief is structured so you can act
without it.

## What we want from you

Six deliverables, in priority order (spelled out in the brief
under "What we're asking from design"):

1. Page-level visual hierarchy critique for `/dashboard` and
   `/hcps/[hcp_key]`
2. Resolution to the KPI sub-line concatenation problem
3. System-level component spec (`<Card>`, `<Button>`, typography
   hierarchy)
4. Engagement status visual standard (Hot / Active / Lapsed / Cold)
5. Color usage audit — especially the warm gold accent
6. Mobile / responsive direction

Plus opinions on the smaller items in the brief (entity search,
tab styling, two trend charts back-to-back, etc.) — happy to take
your read on those alongside the priorities.

## How to structure your response

For each numbered priority deliverable:

1. **Diagnosis** — your read of what's actually wrong (one paragraph)
2. **Recommendation** — concrete proposed treatment. Be specific
   about color values, spacing, sizes — clear enough that an
   engineer can implement without re-asking.
3. **Tradeoffs / open questions** — what you'd want validated by
   user research or a real designer review.

Then end with a **prioritized punch list** synthesizing everything
into top-N actionable changes with rough impact / effort estimates.
If you want to do this iteratively (lock down hierarchy first, then
component spec, then mobile) instead of all at once, say so.

## Constraints

- Light theme only (no dark mode in scope)
- Tailwind v4 with CSS variables — palette is in `ui-patterns.md`
- Two fonts: DM Serif Display (headings + KPI numbers), DM Sans (body)
- Semantic HTML, keyboard-accessible — refinements there welcome
- We're a SaaS data app, not a content site — busy data density is
  acceptable IF grouped well
- No wholesale rebrands — the visual system is established. We want
  refinement, not reset.
- Tablet matters more than phone (managers between meetings is the
  realistic mobile use case; reps on phones in cars is not)

## Out of scope

- **Don't propose feature additions / removals** — that's product
- **Don't critique LLM prompt content** — that's product/engineering
- **Don't worry about i18n** — single-locale (en-US) for now
- **Don't redo what engineering already addressed** — listed in the
  brief's "Already addressed" section. Specifically: empty states
  are standardized, /settings is hidden, /reports empty state is
  fixed, AccountMotion is consolidated, Snapshot parity exists
  across HCP/HCO/Rep, LLM boilerplate is unified.
- **Don't propose a different palette** — but DO flag if specific
  colors are overloaded or have contrast issues.

## Tone / voice

Be opinionated and concrete. We don't want hedging. If you think
the dashboard should have super-section headings, say so and spec
the treatment. If you think the warm gold is overloaded, say what
to swap it with. We can push back if needed but a clear opinion
beats a buffet of options.

Cite specific elements / pages / components when you make a point.
Vague critiques ("the spacing feels off") aren't actionable; we want
"the px-5 padding inside cards is too tight at 1440px viewport for
section headers — recommend px-6."

Open questions are welcome. Flag anything you'd want a real
designer or user research to resolve before committing.

## What good output looks like

Imagine an engineer reading your response and shipping changes
within a day. They have the codebase open, can change colors /
spacing / components freely, but won't make decisions on visual
direction without your input. Optimize for that handoff.

Bonus if you can include:
- ASCII mockups or markdown tables sketching proposed layouts
- "Before / After" comparisons for the highest-impact changes
- A short "what I'd do first if I had 1 day vs 1 week" sequencing

---

Ready when you are. Files attached:
- `design-handoff-brief.md`
- `ui-patterns.md`
- (optional) `site-audit-2026-04-29.md`
