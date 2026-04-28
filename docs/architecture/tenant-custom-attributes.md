# Tenant-custom HCP/HCO attributes — architecture

Status: **design spike, not built.** Companion to
[project_tenant_custom_attributes](../../../.claude/projects/c--Users-jwate-throughline/memory/project_tenant_custom_attributes.md)
memory. This doc is the implementation specification — schema, ingestion paths,
sync, gold layer, LLM consumption.

## Why this needs its own design

`tenant_source_field_map` already handles bronze→silver mapping for ~30 known
typed columns per entity (npi, tier, specialty, etc.). It assumes a closed,
known schema. Tenant-custom scoring data breaks that assumption:

- **Open cardinality:** a single tenant has 50+ scoring fields (one per
  therapy area × time period × source).
- **Tenant-specific naming:** Fennec uses `fen_2024_breast_cancer_decile`;
  another tenant uses something completely different.
- **Multiple sources per tenant:** Komodo deciles via Veeva account__v;
  Clarivate procedure volumes via SFTP file drops; internal scoring from a
  custom feed.
- **Periodic refresh + history:** scores are recomputed monthly/quarterly;
  we want both "current score" (default consumption) and "historical
  trend" (eventual analytical use).

Forcing all of that into typed silver columns means schema churn every time a
tenant adds a new score, AND a separate column per tenant variation. Doesn't
scale past ~3 tenants.

The design here keeps the typed-column path for stable cross-tenant
attributes (npi, tier, specialty) and adds a parallel **flexible attribute
store** for tenant-custom data.

## Data shape examples

Concrete examples we need to support:

**Fennec (Komodo via Veeva):**
- `fen_2024_breast_cancer_decile` — integer 1-10
- `fen_2024_testicular_cancer_decile` — integer 1-10
- `fen_2024_head_neck_cancer_decile` — integer 1-10
- `fen_2024_cervical_cancer_decile` — integer 1-10
- (per HCP, refreshed quarterly via Veeva data load)

**TriSalus (Clarivate via SFTP):**
- `clarivate_2024_ufe_cannulization_volume` — integer count
- `clarivate_2024_uae_volume` — integer count
- (per HCO, delivered as CSV file drops monthly)

Note: clients don't usually do their own internal scoring. **Throughline derives composite scoring** (`gold.hcp_target_score` / `gold.hco_potential_score` below) by blending the third-party inputs above with our own derived signals (call recency, sales attribution, watch-list status). That composite is OURS, surfaced to the LLM and UI, but built on top of the tenant's third-party scoring data.

## Two ingestion paths (both must work)

```
Path A: Veeva-embedded (Fennec / Komodo)
─────────────────────────────────────────
Tenant data ops bulk-loads → Veeva account__v custom fields
→ existing veeva_full_ingest / veeva_incremental → bronze.veeva_obj_account__v
→ silver.hcp_attribute (NEW) via attribute mapping
→ gold.dim_hcp_attribute (NEW)
→ LLM input

Path B: Standalone file drop (Clarivate / direct from third-party)
──────────────────────────────────────────────────────────────────
Third-party delivers CSV → SFTP folder → existing sftp_ingest
→ bronze.sftp_<feed_name> via tenant_sftp_feed config
→ silver.hco_attribute (NEW) via attribute mapping
→ gold.dim_hco_attribute (NEW)
→ LLM input
```

Both paths converge at the silver attribute table. Downstream gold +
consumption is unchanged regardless of source.

## Schema

### Postgres config: `tenant_attribute_map`

Declares which bronze fields are "attributes" + their semantic shape.

```sql
CREATE TABLE tenant_attribute_map (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenant(id) ON DELETE CASCADE,
  source_system   source_system NOT NULL,    -- 'veeva' | 'sftp'
  bronze_table    text NOT NULL,              -- 'veeva_obj_account__v' or 'sftp_komodo_2024'
  bronze_column   text NOT NULL,              -- 'fen_2024_breast_cancer_decile'
  -- Canonical name in our attribute space — chosen by the admin during setup.
  -- Tenants share canonical names where it makes sense (e.g. "breast_cancer_decile")
  -- so analytics + LLM prompts can reference them stably.
  attribute_name  text NOT NULL,              -- 'breast_cancer_decile'
  -- Which entity this attribute belongs to. Drives whether the row lands in
  -- silver.hcp_attribute vs silver.hco_attribute.
  entity_type     attribute_entity_type NOT NULL,  -- 'hcp' | 'hco'
  -- Semantic type — informs the gold rollup + downstream consumption.
  attribute_type  attribute_type NOT NULL,    -- 'decile' | 'score' | 'volume' | 'percentile' | 'categorical' | 'flag'
  -- Source attribution — visible in reports, prompts, audit.
  source_label    text NOT NULL,              -- 'komodo_2024_q4' | 'clarivate_2024_jan' | 'fennec_internal'
  -- Therapy area / product / scope tag for analytics grouping. Optional.
  scope_tag       text,                       -- 'breast_cancer' | 'testicular' | 'all'
  -- Active flag so admins can deactivate without deleting.
  active          boolean NOT NULL DEFAULT true,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  updated_by      text NOT NULL,
  UNIQUE (tenant_id, source_system, bronze_table, bronze_column)
);

CREATE TYPE attribute_entity_type AS ENUM ('hcp', 'hco');
CREATE TYPE attribute_type AS ENUM (
  'decile',       -- integer 1-10 (or 1-N), higher = better
  'score',        -- numeric, range varies; LLM gets the value + needs context
  'volume',       -- integer count (procedures, scripts, etc.)
  'percentile',   -- 0-100
  'categorical',  -- enum string
  'flag'          -- boolean
);
```

### Silver: long-format attribute tables

```sql
-- silver.hcp_attribute (Spark Delta)
CREATE TABLE silver.hcp_attribute (
  tenant_id        STRING    NOT NULL,
  hcp_id           STRING    NOT NULL,    -- Veeva account_id (matches silver.hcp.veeva_account_id)
  attribute_name   STRING    NOT NULL,    -- canonical, from tenant_attribute_map
  attribute_value  STRING,                 -- raw value (always string; gold parses per type)
  attribute_type   STRING    NOT NULL,    -- 'decile' | 'score' | etc.
  source_system    STRING    NOT NULL,    -- 'veeva' | 'sftp'
  source_label     STRING    NOT NULL,    -- e.g. 'komodo_2024_q4'
  scope_tag        STRING,                 -- e.g. 'breast_cancer'
  -- When this score was COMPUTED by the source (Komodo's quarter-end date,
  -- Clarivate's file delivery date, etc.). Distinct from silver_built_at
  -- which is when WE ingested it. Most-recent only — overwritten on each
  -- refresh per the "current only" history decision.
  valid_as_of      DATE,
  silver_built_at  TIMESTAMP NOT NULL
) USING DELTA;
-- Primary key: (tenant_id, hcp_id, attribute_name). Refresh = MERGE/upsert
-- on this key, NOT append. Old values overwritten in place.
```

`silver.hco_attribute` is structurally identical but keyed on `hco_id`.

**Why long format:** new attributes don't require schema changes. Tradeoff:
queries need to PIVOT to get a wide row per HCP/HCO. Gold materializes the
wide pivot for the most common access pattern.

### Gold: long view + wide rollup + composite scores

Three gold artifacts:

1. **`gold.dim_hcp_attribute`** — long format, joined to `dim_hcp` by hcp_key.
   Same shape as silver but with surrogate key + parsed numeric values
   alongside the raw string.
   ```sql
   CREATE TABLE gold.dim_hcp_attribute (
     attribute_key       STRING    NOT NULL,  -- md5(tenant + hcp + name + valid_as_of)
     hcp_key             STRING    NOT NULL,  -- joins dim_hcp.hcp_key
     tenant_id           STRING    NOT NULL,
     attribute_name      STRING    NOT NULL,
     attribute_value     STRING,               -- raw
     attribute_value_num DOUBLE,               -- parsed (NULL for categorical)
     attribute_type      STRING    NOT NULL,
     source_label        STRING    NOT NULL,
     scope_tag           STRING,
     valid_as_of         DATE,
     gold_built_at       TIMESTAMP NOT NULL
   ) USING DELTA;
   ```

2. **`gold.dim_hcp_score_wide`** — pivoted view of the most-queried numeric
   attributes. Materialized periodically; columns are derived from a
   tenant-specific config of "which attributes to pivot." Faster JOINs from
   fact tables than the long format.
   ```sql
   -- Per-tenant generated. Example for fennec:
   CREATE TABLE gold.dim_hcp_score_wide AS
   SELECT
     hcp_key,
     tenant_id,
     MAX(CASE WHEN attribute_name = 'breast_cancer_decile'    THEN attribute_value_num END) AS breast_cancer_decile,
     MAX(CASE WHEN attribute_name = 'testicular_cancer_decile' THEN attribute_value_num END) AS testicular_cancer_decile,
     MAX(CASE WHEN attribute_name = 'head_neck_cancer_decile'  THEN attribute_value_num END) AS head_neck_cancer_decile,
     -- etc., generated from tenant_attribute_map
     gold_built_at
   FROM gold.dim_hcp_attribute
   WHERE attribute_type IN ('decile', 'score', 'percentile')
   GROUP BY hcp_key, tenant_id, gold_built_at;
   ```

3. **`gold.hcp_target_score`** — composite "should-call" score per (HCP,
   product/therapy_area). Combines raw third-party deciles + our derived
   signals (call recency, sales attribution, watch-list status). This is
   the abstraction layer the LLM consumes.
   ```sql
   CREATE TABLE gold.hcp_target_score (
     hcp_key          STRING NOT NULL,
     tenant_id        STRING NOT NULL,
     product_or_ta    STRING NOT NULL,  -- 'breast_cancer' | 'all' | 'trinav' etc.
     -- Composite 0-100: weighted blend of raw deciles + activity signals +
     -- (eventually) ML model output. Per-tenant weighting config.
     score_value      DOUBLE NOT NULL,
     -- Top contributors to the score, JSON, for explainability
     -- ("why is this HCP scored 87?"). Surfaced in LLM prompts so the
     -- recommendation reasons can cite specifics.
     contributors     STRING,           -- JSON
     valid_as_of      DATE NOT NULL,
     gold_built_at    TIMESTAMP NOT NULL
   ) USING DELTA;
   ```
   Same shape for `gold.hco_potential_score`.

## Notebooks (Spark, mirroring existing patterns)

1. **`silver_hcp_attribute_build`** — reads `tenant_attribute_map` filtered to
   `entity_type='hcp'`, groups by `(tenant, source_system, bronze_table)`,
   generates per-group SELECT pulling each declared bronze column → unpivot →
   union → write to `silver.hcp_attribute` with overwriteSchema. Mirrors the
   structure of `silver_hcp_build` but using config rows differently
   (one bronze column per output row instead of one bronze column per
   silver column).

2. **`silver_hco_attribute_build`** — same shape for HCO entities.

3. **`gold_dim_hcp_attribute_build`** — joins silver.hcp_attribute to
   silver.hcp for the hcp_key surrogate, parses numeric values per type,
   writes gold.dim_hcp_attribute.

4. **`gold_dim_hcp_score_wide_build`** — pivots the long format into a wide
   per-attribute-name table. Auto-generates the pivot columns from
   `tenant_attribute_map` config for the active tenant.

5. **`gold_hcp_target_score_build`** — combines raw scores + activity + (when
   ML lands) model output into a composite. Per-tenant weighting config in
   Postgres → Fabric config sync.

Add to `incremental_refresh_pipeline` orchestrator after the entity dim
builds (dim_hcp, dim_hco) so attributes JOIN cleanly.

## Web layer changes

### Admin UI: `/admin/attributes`

New admin route for managing the `tenant_attribute_map` config. Table view:

| Bronze table | Bronze column | Attribute name | Entity | Type | Source label | Active |
|---|---|---|---|---|---|---|
| veeva_obj_account__v | fen_2024_breast_cancer_decile | breast_cancer_decile | hcp | decile | komodo_2024_q4 | ✓ |
| sftp_clarivate_2024 | ufe_cannulization_volume | ufe_volume | hco | volume | clarivate_2024 | ✓ |

Inline edit + add row + activate/deactivate. CSV upload for bulk-defining
attributes (a tenant onboarding likely loads 50+ attribute mappings at once).

Same authoring model as `/admin/mappings` and `/admin/goals` — Postgres is
authoritative; Fabric mirrors via config_sync.

### LLM input loaders

`lib/rep-recommendations.ts` already has placeholder fields. Once gold tables
land, populate them:

```typescript
// New loader: lib/hcp-target-scores.ts
export async function loadHcpTargetScores(args: {
  tenantId: string;
  hcpKeys: string[];
  productOrTa?: string; // optional filter
}): Promise<{ hcp_key: string; score_value: number; contributors: string[] }[]>;

// In gather function:
inputs.predictions.hcp_target_scores = await loadHcpTargetScores({
  tenantId,
  hcpKeys: [...allHcpKeys, ...extras],
});
```

The prompt is already instructed to "use any non-empty `predictions` field if
relevant." No prompt rewrite needed — just populate the input.

Same pattern for `loadHcoPotentialScores` → `inputs.predictions.hco_potential`.

### Conversational analytics surface (Surface A, future)

When this lands, the chat tool registry gets new tools:
- `query_hcp_scores(scope_tag, n)` — "show me top 20 HCPs by breast cancer decile in my book"
- `query_hco_potential(metric, threshold)` — "which HCOs in CA have UFE volume > 50?"

These tools wrap loaders that hit `gold.dim_hcp_score_wide` /
`gold.dim_hcp_attribute`. The chat surface naturally surfaces this data
without us hand-building UI for every combination.

## Implementation phasing

**Phase 1 (1-2 days): Schema + admin UI**
- Postgres migration: `tenant_attribute_map` + enums
- `silver.hcp_attribute` + `silver.hco_attribute` Delta table DDL (empty)
- `/admin/attributes` UI for the config
- config_sync extension for `tenant_attribute_map`

**Phase 2 (3-5 days): Ingestion**
- `silver_hcp_attribute_build` notebook (config-driven, both Veeva + SFTP
  source paths)
- `silver_hco_attribute_build` notebook
- Add to `incremental_refresh_pipeline`
- Test with fennec's `fen_2024_*_decile` fields

**Phase 3 (2-3 days): Gold + LLM input**
- `gold_dim_hcp_attribute_build` (long format)
- `gold_dim_hcp_score_wide_build` (pivot)
- `lib/hcp-target-scores.ts` loader
- Wire into rep-recommendations input gathering
- Verify recommendation quality lift

**Phase 4 (when needed): Composite scoring**
- `gold_hcp_target_score_build` notebook
- Per-tenant weighting config
- Surface contributor explainability in LLM reasoning

**Phase 5 (with Surface A): Conversational tools**
- New tools in the chat registry that query attribute tables

## Open questions to resolve before Phase 1

1. **Canonical attribute names — registry or per-tenant?** A registry of
   well-known attribute names (`breast_cancer_decile`, `ufe_volume`) lets us
   reuse prompts + UI across tenants. But each tenant has unique custom
   attributes too. **Lean: registry of common ones + free-text for custom.**

2. **Refresh cadence per source — RESOLVED.** Run silver_hcp_attribute_build
   every incremental cycle. Both Veeva-embedded and SFTP-delivered sources
   ride the same pipeline; the bronze-modified-since check naturally skips
   when nothing changed. Source mix per tenant is some-via-Veeva +
   some-via-SFTP-CSV; the unified silver build handles both transparently.

3. **Historical retention — RESOLVED.** Keep current only. These are
   periodic loads (monthly / quarterly / annual) that often stay stable for
   1-2+ years until the next dataset arrives. "History" of unchanged values
   would be sparse and not operationally useful. silver/gold tables hold
   the most-recent value per (tenant, entity, attribute_name); a refresh
   overwrites in place. If a future use case needs trended scores, we can
   add an SCD2 layer then — cheap to bolt on later.

4. **Composite score weighting — config or hardcoded?** Each tenant's
   `gold.hcp_target_score` should weight inputs differently (Tier 1 weight
   high, decile contribution depends on therapy area mix). **Lean: per-tenant
   config in Postgres (`tenant_target_score_weights`); start with sensible
   defaults; tune per-customer.**

5. **PHI / compliance handling.** Komodo / Clarivate data isn't direct PHI
   but is HIPAA-adjacent. Audit trail for who configured which attribute
   mapping is the minimum bar. **Lean: audit log on `tenant_attribute_map`
   updates (already partially covered by `updated_by` + `updated_at`).**

## What this DOESN'T do

- ML training infrastructure (out of scope; gold tables FEED an ML pipeline
  but don't include training)
- Conversational analytics implementation (separate spike)
- Real-time / streaming attribute updates (batch only — refresh at most
  every 30 min via incremental cycle)
- Fine-grained per-attribute access control (e.g., "only managers can see
  Komodo deciles") — defer until a customer requires it

## Trigger to start Phase 1

- A real customer (fennec, TriSalus, or a third) is on deck and their
  targeting workflow depends on third-party scoring data, OR
- We need to demo recommendations quality to a prospect and the
  current coverage-fallback recommendations aren't good enough

Pre-customer this is speculative. Post-customer-signing it's load-bearing.

## Cross-references

- [project_tenant_custom_attributes](../../../.claude/projects/c--Users-jwate-throughline/memory/project_tenant_custom_attributes.md) — the originating memory
- [project_llm_input_extensibility](../../../.claude/projects/c--Users-jwate-throughline/memory/project_llm_input_extensibility.md) — the LLM consumption pattern this design serves
- [docs/product/llm-expansion.md](../product/llm-expansion.md) "Tenant-custom third-party data" — product framing
- [docs/product/ai-layer.md](../product/ai-layer.md) "HCP/HCO targeting ML" — the future ML layer that will SHARE this attribute foundation
