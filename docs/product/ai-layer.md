# AI / ML layer — future-state vision

Status: **future state, not built.** Captured here so near-term decisions
(data model, tenant isolation, gold table granularity) don't paint us into a
corner when this work lands.

## Four surfaces we expect to build

### 1. Conversational analytics (in-product LLM)

An in-app chat widget authenticated users can ask natural-language questions
of their data: *"How many call attainment gaps do we have in Q2?"*, *"Which
HCOs are underpenetrated vs. their peer group?"*, *"Show me reps trending
down on new starts."*

Shape we anticipate:
- Claude API (or equivalent) as the LLM
- Tool use: text-to-DAX against the semantic model; text-to-SQL against the
  lakehouse SQL endpoint for operations the semantic model doesn't cover
- Tenant isolation: the agent operates strictly within the signed-in user's
  `tenant_id` scope, passed as a system prompt constraint AND enforced at the
  query layer (same RLS story as PBI embed)
- Grounding: RAG over the tenant's field-map, mapping tables, and semantic
  model metadata so the agent understands terminology

### 2. HCP / HCO targeting ML

Predictive scoring of which HCPs or HCOs are worth targeting for a given
product, territory, or call cycle. Output as a silver/gold table
(`gold.hcp_target_score` or similar).

Shape we anticipate:
- Batch scoring via Spark ML or Python notebooks in Fabric
- Features: historical call activity, demand (Rx), HCO size/type, peer-group
  behavior, prescribing history
- Served as tables; PBI reports consume directly
- Per-tenant models (training signals differ per client's product portfolio)
- Model registry: Fabric's built-in MLflow integration

### 3. Forecasting

Demand forecasting, call-attainment projections, inventory planning.
Standard time-series ML territory.

Shape we anticipate:
- Prophet / ARIMA / boosted-tree ensemble per product-territory series
- Weekly or monthly refresh cadence
- Output in `gold.fact_forecast` with `forecast_date`, `horizon`, `metric`,
  `value`, `lower_bound`, `upper_bound`
- UI: overlay forecast on actuals in PBI visuals

### 4. Call log NLP / scoring

Extract structured signal from call notes reps write: sentiment, topics
discussed, objections raised, follow-ups promised, effectiveness proxy.

Shape we anticipate:
- LLM on call notes (Claude or similar), structured extraction via tool use
- Output enriches `silver.call` with: `extracted_topics`, `sentiment_score`,
  `followup_promised`, `compliance_flags`
- Compliance-sensitive: call notes can contain PHI. Vet whether data can leave
  tenant storage for LLM processing; may require Azure-hosted model or a
  private Bedrock/Azure OpenAI endpoint per client preference

## What this means for today's decisions

Design choices we make now should not preclude any of the above. Specifically:

- **Keep `tenant_id` pervasive** — needed for ML training/scoring isolation.
  Already in architecture.
- **Gold tables must preserve granularity** — summary-only gold hurts ML.
  Build dims + facts at the lowest meaningful grain; aggregate in the visual
  layer, not the storage layer.
- **Silver columns that look "extra" are load-bearing for NLP** — free-text
  call notes, physician specialty detail, product attribute strings. Don't
  normalize them away.
- **Compliance posture** — before any client data touches an LLM endpoint,
  we'll need a tenant-level config toggle (`ai_processing_enabled`) plus a
  data-processing addendum (DPA) covering the LLM vendor. Add to Postgres
  tenant config when AI features go live.
- **Model output isolation** — AI-generated scores, forecasts, extracted
  fields all carry `tenant_id`. Same RLS pattern as human-sourced data.
- **Cost allocation** — LLM/ML usage should be trackable per tenant
  (eventually a billing signal). Add `ai_usage` logging to `ops/` when the
  first AI feature ships.

## Not in scope here

- Specific model choices (when we build, evaluate against latest state)
- Vendor selection (Anthropic vs OpenAI vs Azure OpenAI vs open-weight
  self-hosted) — depends on each client's compliance posture
- Training infrastructure vs. pure inference — will be case-by-case

## Trigger for starting

Earliest: after the first paying customer has been live for a quarter and
we have enough real data to train anything useful. Before that, any ML work
is demoware.

Exception: conversational analytics (surface 1) could ship earlier — it's a
value-add on existing PBI semantic models and doesn't require training data,
just tool use against what already exists.
