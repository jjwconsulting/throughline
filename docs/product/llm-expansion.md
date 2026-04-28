# LLM expansion — design spike

Status: **v1 of all three surfaces SHIPPED 2026-04-28.** Synopsis on
`/dashboard`, action recommendations on `/reps/[user_key]`, and
conversational analytics at `/ask`. This doc is preserved as the
design rationale + the v2 / future-state direction. Companion to
[ai-layer.md](ai-layer.md) (broader future-state vision).

## What we already use the LLM for

Two surfaces ship today:

1. **Inbox priority brief** — Claude reads the assembled signal list
   on `/inbox` and produces a 2-3 sentence "what to look at first"
   summary at the top of the page. Per-request, no caching.
2. **On-demand goal-recommendation rationale** — `/admin/goals` rows
   each have a `?` button; clicking it triggers a Claude narration of
   the recommendation engine's chosen value (4-window history + peer
   median + trend). Per-row, on-demand to avoid burning the LLM
   eagerly for 91+ reps.

Both use the Anthropic API directly, via `lib/anthropic.ts` (or
similar). Sonnet-tier model. No persistence; each call is fresh.

The infrastructure (API key, error handling, prompt-construction
helpers) exists. Expanding to the next layer doesn't require new
plumbing — just new prompts + UI surfaces.

## Three candidate next surfaces

### A. Conversational analytics ("ask your data")

In-app chat widget where authenticated users ask natural-language
questions: "How many Tier 1 HCPs have I not contacted this quarter?"
"Which 5 accounts dropped most last month vs. the one before?" "Show
me my territories' attainment ranked worst first."

**Architecture:**
- Tool use pattern. Define ~10 tools that map to existing loaders:
  `query_top_accounts`, `query_account_motion`, `query_tier_coverage`,
  `query_team_rollup`, `lookup_rep`, `lookup_hco`, `query_matrix`
  (the `/explore` generic loader), etc.
- LLM picks the tool + parameters; we execute against Fabric/Postgres
  with the user's RLS scope; LLM narrates the result + offers a
  drill-through link.
- Conversation state in localStorage (no server persistence yet).
- Render: chat thread on the right side of any page (drawer), or
  dedicated `/ask` route.

**Pros:** highest user-visible "wow." Differentiator vs PBI which
forces a query-builder UI for the same thing. Reuses every loader
we've built.

**Cons:** trust burden — wrong answer = lost credibility. Need
tight tool boundaries + result citation ("based on N rows from
gold.fact_call where ..."). Conversational UX is harder to nail than
single-shot prompts. Prompt iteration cycle is long.

**Effort:** 2-3 weeks for v1. Tool registry + chat UI + grounded
prompt + observability. Defensible v1: support 5 question shapes
well, fall back to "I don't know how to answer that — try the
[Explore] page" for everything else.

### B. Proactive synopsis (scheduled "what changed" digest)

LLM-generated narrative of what changed in the user's data since
their last visit. Surfaces in two places:
- A "Since you last logged in" card at the top of `/dashboard`
- (Later) Email digest: weekly Monday morning summary

**Architecture:**
- Server-side cron (or Fabric scheduled notebook) computes the
  delta-since-last-visit per user using existing loaders + a
  `last_visit_at` timestamp on `tenant_user`.
- LLM gets structured input: top movers, watch-list adds, signals
  triggered, attainment shifts.
- Prompt produces a 4-6 sentence narration with concrete numbers
  + recommended action.
- Cached per-user with TTL = next scheduled run. Display reads
  cache; cache miss falls back to "checking..." + computes inline.

**Pros:** zero-cost-to-the-user — they just see a summary. Builds
trust gradually because each item links to the underlying data.
The natural lead-in to the email digest surface.

**Cons:** requires `last_visit_at` infrastructure (small Postgres
column + middleware update) and a way to compute deltas (mostly
exists in our period-over-period loaders). Cache invalidation
when data refreshes.

**Effort:** 1 week for v1. Reuses Account Motion + signals + KPI
math. Shipping as "Since you last logged in" card on dashboard
first, email digest is a follow-up that swaps the delivery channel.

### C. Action recommendations (per-rep daily/weekly call list)

**Important framing (added 2026-04-28):** v1 ships the recommendation card. v2 is NOT "Mark as called" checkboxes — Veeva is the source of truth for calls, and a parallel state-tracking UI would diverge from it. The right v2 pattern is **action buttons per row that help the rep EXECUTE the suggestion** (Open in Veeva, Show past activity, Generate call brief, Find similar HCPs, Pull related sales). See [project_rep_action_paradigm](../../../.claude/projects/c--Users-jwate-throughline/memory/project_rep_action_paradigm.md) memory for the full reasoning. The "Generate call brief" action specifically bridges into LLM tool use — same composition pattern that powers Surface A.


LLM-suggested "here's who you should call this week and why."
Inputs: rep's coverage HCOs, recent calls, tier coverage gaps,
sales motion, signals. Output: a ranked list with a 1-sentence
reason per item.

**Architecture:**
- Daily batch: for each rep, gather inputs (loaders), prompt the
  LLM with rep context + recommendation request, persist top N
  to a `gold.rep_recommendation` table (or Postgres equivalent).
- Surface on `/reps/[user_key]` (rep's own view) as a "Suggested
  this week" card; on `/dashboard` for managers as a team-level
  rollup ("3 reps haven't called their top 5 in 14 days").
- Per-rec dismiss + completion tracking (so the LLM learns what's
  useful — though "learns" here means "we exclude dismissed
  patterns next time," not actual fine-tuning).

**Pros:** highest operational value. Actually changes rep
behavior — a list of "who to call today" is what reps want from
analytics. Strong differentiator.

**Cons:** highest stakes — bad recommendations = wasted rep time
+ trust loss. Needs careful evaluation before shipping; would
benefit from a customer pilot to tune the prompt against their
actual workflow.

**Effort:** 2-3 weeks for v1. Batch infra + per-rep prompt + UI
surface + dismiss/completion tracking + observability.

## Recommended phasing

**Phase 1 (next): B — proactive synopsis on /dashboard.**

- Smallest scope, biggest "wow per line of code."
- Reuses existing loaders entirely; only new code is a delta
  computer + LLM narration prompt + the UI card.
- Builds the LLM-narration muscle (prompt iteration, error
  handling, cost monitoring) that the other two surfaces need.
- Naturally extends to email digest later.
- Low trust risk: it's narrating numbers we computed, with each
  item linking back to its source. "Top declining account: City
  of Hope (-23 units vs prior week) → /hcos/abc" is hard to get
  wrong.

**Phase 2: C — action recommendations on /reps.**

- Higher operational impact once we have a customer to tune
  with.
- Builds on Phase 1's narration patterns + per-user batch infra.

**Phase 3: A — conversational analytics.**

- Biggest "wow" but biggest trust + UX surface.
- Worth doing when the tool registry is rich (= after we've
  built more loaders) and we have a customer to validate
  question coverage against.

## Architecture decisions to lock in early

These cut across all three surfaces — pick once, apply everywhere.

1. **Model selection** — Claude Sonnet for narration / structured
   output (cheap, fast, good enough). Claude Opus for the
   conversational tool-use surface (better tool-use reasoning, worth
   the cost on a per-question basis). API direct via `@anthropic-ai/sdk`.
2. **Tenant isolation in prompts** — every system prompt includes
   `tenant_id` + role context as constraints. Tool implementations
   ALSO enforce RLS at the query layer — never trust the LLM to
   honor scope. Belt + suspenders.
3. **Citations are non-negotiable** — every LLM-generated number
   in the UI links to its source loader / detail page. No bare
   claims. "Net units down 20%" must link to the exact filter view
   showing -20%.
4. **Cost tracking** — log every LLM call to `ops.ai_usage` (new
   table) with `tenant_id`, `surface`, `input_tokens`,
   `output_tokens`, `model`, `latency_ms`. Useful for both billing
   signal and cost-per-feature analysis.
5. **Prompt versioning** — prompts live in a single
   `lib/llm-prompts.ts` (or per-surface files). Version them via
   git history; if a prompt changes meaningfully, log the version
   alongside the call so we can A/B compare.
6. **Compliance posture** — same as `ai-layer.md`: no PHI in
   prompts unless tenant config has `ai_processing_enabled = true`
   AND we have a DPA with the vendor. Fennec data is anonymized for
   demo, but the moment we onboard a real pharma client, this gate
   ships first.

## Trust + safety considerations

- **Hallucination guard** — never let the LLM invent numbers. Prompts
  always include the actual data; LLM just narrates. If a number
  doesn't appear in the input, it doesn't appear in the output.
- **Negative-result handling** — when the data shows nothing
  meaningful, the LLM says so. Don't reach for false signals.
  Failure mode to test: "Tell me what changed" when nothing did.
- **Manual review surface** — early on, every LLM response should be
  thumbs-up/down-able (logged) so we can track quality drift over
  time. Add a tiny feedback widget alongside any LLM-generated text.
- **Latency budget** — narration < 2 seconds (cached); chat < 5
  seconds first token. Long-running prompts get a "thinking..."
  indicator + cancelable.
- **Failure mode** — when the LLM fails (rate limit, timeout, bad
  output), surface clean fallback ("LLM unavailable; here's the
  underlying data"). Never crash the page.

## What this DOESN'T cover

- HCP/HCO targeting ML (surface 2 in ai-layer.md) — needs training
  data, deferred until first customer is live.
- Forecasting (surface 3) — same.
- Call log NLP (surface 4) — needs PHI compliance posture sorted
  first.
- Open-weight / self-hosted LLMs — only matters once a client
  requires it. Defer.

## Effort estimate summary

| Surface | Estimate | Risk | Wow factor |
|---|---|---|---|
| **B** Proactive synopsis | 1 week | Low | Medium |
| **C** Action recommendations | 2-3 weeks | Med-high | High |
| **A** Conversational analytics | 2-3 weeks | High | Highest |

Recommendation: ship B in the next session (concrete enough to
finish in one focused block), use what we learn to scope C, and
queue A for after we have customer validation on what questions
they actually ask.

## Future inputs: ML scoring, forecasting, other analytical surfaces

Critical architectural commitment: LLM surfaces (synopsis, action
recommendations, eventually conversational) operate as **narrators
over structured input**. They never invent. This means the value
each surface delivers is a function of what we put INTO the prompt —
which means our analytical surface investments compound into LLM
quality without any LLM-side rewrites.

**What's in inputs today (V1):**
- Aggregated activity (calls per HCP, units per HCO)
- Period-over-period motion (rising / declining / watch list / new)
- Coverage facts (which HCPs/HCOs in scope, tier breakdown)
- Triggered signals (inactivity, activity drop, over-targeting,
  goal pace behind)

**What we'll fold in as we build the data foundation:**

| Future surface | LLM consumes as |
|---|---|
| `gold.hcp_target_score` (per-HCP propensity model) | `inputs.predictions.hcp_targeting_scores: [{ hcp_key, score, why_high }]` — LLM ranks recommendations partly by score, surfaces high-score-low-recent-activity HCPs |
| `gold.hco_potential_score` (per-HCO market sizing) | `inputs.predictions.hco_potential: [{ hco_key, opportunity_$, current_capture_pct }]` — LLM surfaces under-penetrated high-potential HCOs |
| `gold.fact_forecast` (per-territory unit forecast w/ bounds) | `inputs.forecasts.territory_trajectories: [{ territory_key, projected_eop, vs_goal_likelihood }]` — LLM warns of likely goal misses early |
| `gold.fact_call_nlp` (extracted topics, sentiment, follow-ups from call notes) | `inputs.call_intelligence.followups_promised: [{ rep, hcp, what }]` — LLM surfaces broken promises ("Jane Doe promised to send X to Dr. Y three weeks ago") |
| `gold.cohort_benchmarks` (peer-group performance) | `inputs.benchmarks.peer_comparison: [{ rep_or_hco, metric, vs_peer_pct }]` — LLM contextualizes performance ("Jane is bottom-quartile on Tier 1 coverage among SAMs") |

**Tenant-custom third-party data (Komodo / Clarivate / IQVIA):**

The richest near-term scoring inputs aren't from us building ML — they're from third-party prescribing/procedure data that pharma tenants load into their Veeva tenant as custom account fields. Examples:
- Fennec: `fen_2024_breast_cancer_decile`, `fen_2024_testicular_cancer_decile` — per-HCP Komodo deciles by therapy area
- TriSalus: Clarivate UFE cannulization volumes per HCO

Today, our `tenant_source_field_map` handles ~30 known mappings into typed silver columns. It doesn't accommodate flexible attribute spaces (50+ tenant-specific scoring fields per HCP). Design for this lives in `project_tenant_custom_attributes` memory — long-format `silver.hcp_attribute` + `tenant_attribute_map` config. When that ships, those attributes feed `gold.hcp_target_score` → which feeds the `predictions.hcp_target_scores` LLM input field via the same plug-in pattern. **No LLM-side rewrites required** — that's the whole point.

Until that data plumbing exists, LLM recommendations on /reps are noticeably coverage-fallback-prone for reps with limited recent activity (since the LLM has no scoring signal to differentiate "this HCO matters more"). This is observable today and is the right diagnostic signal that the data foundation needs the third-party scoring layer.

**Architectural rules that protect this path:**

1. **Input shape is open-ended.** Every surface's "input gathering"
   function returns a typed object with named fields. New analytical
   sources add new top-level fields, never overwrite existing ones.
   The LLM prompt instructs "use any input field that's relevant;
   ignore fields that are empty."
2. **Prompts are versioned.** When we add a new input category, the
   prompt may need a hint about how to use it (e.g., "if HCP target
   scores are present, use them as a priority signal alongside
   recent activity"). Bumping the prompt version logs alongside the
   call so we can A/B compare.
3. **Loaders, not data transforms.** LLM-input gatherers call
   existing loaders (e.g. `loadAccountMotion`, future
   `loadHcpTargetScores`). They never reshape data themselves —
   keeps the model surface aligned with what other UI surfaces use.
4. **Per-surface input budget.** Each LLM call has a token budget;
   inputs get prioritized + truncated when over. Track which inputs
   "matter" for each surface so we know what to keep when budget
   pressure hits.

**When this matters:** mostly at the recommendations + conversational
surfaces, where richer inputs = better picks / better answers. The
synopsis surface is naturally bounded (it's a recap, not a
prediction), so additions there are nice-to-have rather than
load-bearing.

## Synopsis tuning (post-ship — revisit when prod cadence is real)

V1 ships with `MIN_HOURS_BETWEEN_GENERATIONS = 4` per user
(`lib/synopsis.ts`). This caps the user-visible "new synopsis" churn
to at most one fresh narration every 4 hours, regardless of how
often pipeline_runs land.

Why a hard-coded constant for V1: dev runs the incremental refresh
once per day, so the gate effectively never fires. Prod will run
every 30-60 min, where the gate matters — without it, every
pipeline_run would force a fresh synopsis even if the data hasn't
materially moved.

**When to revisit:**
- After a real customer is live for a quarter (we'll have signal on
  whether 4 hours feels right)
- If users complain about staleness ("I refreshed 5x and it didn't
  update") OR noise ("a new summary every hour, none of them
  meaningful")
- If a customer wants a different cadence than the global default

**Likely end-state shape:** promote to `tenant.synopsis_min_gap_hours`
(per-tenant config) defaulting to 4, with a global override for our
demo tenant. Could also add a "force refresh" admin button for
support cases where the most recent synopsis is wrong.

**What's NOT rate-limited:**
- Cache hits within the same pipeline_run cost nothing — gate
  doesn't apply.
- Page renders / reads — only LLM GENERATION is gated.
- Dismiss + re-show within the gate window — once dismissed, the
  card stays hidden until BOTH a new run AND the gate clears.

## Open decisions before building B

1. **Where does "since last visit" anchor?** — `tenant_user.last_seen_at`
   updated by middleware on every request? Or `last_dismissed_synopsis_at`
   so users can mark a synopsis read? The latter avoids "since 4 minutes
   ago" awkwardness.
2. **Cache TTL** — recompute on every page load? Recompute once per
   data refresh (i.e., key the cache by latest `pipeline_run.completed_at`)?
   Latter is way cheaper.
3. **What goes in?** — top movers, signals, attainment shifts, watch-list
   adds. Need to pick a max input size — too much context = LLM glosses
   over things; too little = misses important changes. Suggest:
   top 5 of each category.
4. **Where on /dashboard?** — top of page above the KPI cards? Right
   sidebar? In the header? Top-of-page is highest visibility but
   pushes the existing surfaces down.
5. **What to do when there's nothing to say?** — hide the card
   entirely? Show "No notable changes this week"? Hiding feels
   right; an empty card is noise.
