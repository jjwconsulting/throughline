# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {
# META     "lakehouse": {
# META       "default_lakehouse": "aaab7cf8-9b09-435e-8259-d666601d7472",
# META       "default_lakehouse_name": "throughline_lakehouse",
# META       "default_lakehouse_workspace_id": "a2a0bfa2-0d9d-4787-849a-b0a215495876",
# META       "known_lakehouses": [
# META         {
# META           "id": "aaab7cf8-9b09-435e-8259-d666601d7472"
# META         }
# META       ]
# META     }
# META   }
# META }

# MARKDOWN ********************

# # Gold build: hcp_target_score
# Composite "should-call" score per (HCP, scope_tag), in the range 0-100.
# This is the abstraction layer the LLM consumes via
# `lib/hcp-target-scores.ts`. One row per (tenant, hcp, scope_tag) for
# scope_tags present in active attribute mappings, plus one synthetic
# `scope_tag = '__all__'` row that averages every contributing attribute
# regardless of scope (the "no specific therapy area in mind" question).
#
# **Type-aware normalization** (each attribute → 0-100 contribution):
#   - **decile**:    raw / 10 * 100 (bounded; assumes 1-10 scale)
#   - **percentile**: pass through (already 0-100)
#   - **score**:     PERCENT_RANK() within (tenant, attribute_name) → 0-100
#   - **volume**:    PERCENT_RANK() within (tenant, attribute_name) → 0-100
#                    (raw counts aren't comparable across attributes; rank is)
#   - **flag**:      0 or 100 (1.0 → 100, 0.0 → 0)
#   - **categorical**: skipped (no numeric contribution)
#
# **Composite math (v1):** simple mean of the per-attribute normalized
# contributions for the scope. Sufficient for fennec's all-volume case
# where rank-norm of cisplatin volume IS the targeting signal. Per-tenant
# weighting config (tenant_target_score_weights) is Phase 4 follow-up;
# defaults to equal-weighted mean today.
#
# **Contributors JSON:** Top contributors by normalized score, with raw
# value + scope_tag, so LLM rationales can cite specifics ("scored 87
# because top decile in cisplatin volume + tier 1"). Capped at top 5
# per row to keep prompt tokens bounded.
#
# **Derived signals (call recency, sales motion):** NOT blended in this
# composite — kept as separate LLM input fields per
# project_llm_input_extensibility (each input compounds independently).
# We can layer derived signals into a higher-order composite later; for
# now this score is purely the third-party-attribute signal that was
# previously absent from LLM input.
#
# Build dependency: gold.dim_hcp_attribute. Sequence after the long-format
# build in the orchestrator.

# CELL ********************

GOLD_LONG = "gold.dim_hcp_attribute"
GOLD_SCORE = "gold.hcp_target_score"
TOP_CONTRIBUTORS = 5

spark.sql("CREATE SCHEMA IF NOT EXISTS gold")
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {GOLD_SCORE} (
  hcp_key       STRING NOT NULL,
  tenant_id     STRING NOT NULL,
  -- scope_tag from the contributing attributes. '__all__' = composite
  -- across every scope (tenant-wide signal). LLM tools take an optional
  -- scope_tag arg + fall back to '__all__' when caller has no preference.
  scope_tag     STRING NOT NULL,
  -- 0-100 weighted blend. NULL when no numeric contributions for the
  -- (hcp, scope) — those rows aren't written.
  score_value   DOUBLE NOT NULL,
  -- Number of attributes that contributed. Useful as a confidence hint:
  -- a score from 6 contributing attributes is more reliable than 1.
  contributor_count INT NOT NULL,
  -- JSON array of the top contributing attributes, each:
  -- { "attribute_name": "...", "raw_value": "...", "normalized": <0-100>,
  --   "source_label": "...", "scope_tag": "..." }
  -- Surfaced verbatim to the LLM for "why is this HCP scored X" reasoning.
  contributors  STRING,
  gold_built_at TIMESTAMP NOT NULL
) USING DELTA
""")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Step 1: per-attribute-row normalized contribution. PERCENT_RANK is
# computed inline in SQL for score/volume types; the others have
# closed-form normalizations. Skip categorical (no numeric value).

normalized_sql = f"""
WITH base AS (
  SELECT
    g.hcp_key,
    g.tenant_id,
    g.attribute_name,
    g.attribute_type,
    g.attribute_value,
    g.attribute_value_num,
    g.source_label,
    -- Treat NULL scope_tag as 'all' so it groups consistently with
    -- explicit-scope rows. Display in the contributors JSON as 'all'.
    COALESCE(g.scope_tag, 'all') AS scope_tag
  FROM {GOLD_LONG} g
  WHERE g.attribute_value_num IS NOT NULL
    AND g.attribute_type IN ('decile', 'percentile', 'score', 'volume', 'flag')
),
ranked AS (
  -- PERCENT_RANK is 0-1; multiply by 100 for the 0-100 scale.
  -- Computed per (tenant, attribute_name) so cross-attribute scales
  -- are comparable.
  SELECT
    *,
    PERCENT_RANK() OVER (
      PARTITION BY tenant_id, attribute_name
      ORDER BY attribute_value_num
    ) * 100.0 AS pct_rank_norm
  FROM base
),
contributions AS (
  SELECT
    hcp_key,
    tenant_id,
    attribute_name,
    attribute_type,
    attribute_value,
    source_label,
    scope_tag,
    CASE attribute_type
      WHEN 'decile'     THEN LEAST(100.0, GREATEST(0.0, attribute_value_num * 10.0))
      WHEN 'percentile' THEN LEAST(100.0, GREATEST(0.0, attribute_value_num))
      WHEN 'score'      THEN pct_rank_norm
      WHEN 'volume'     THEN pct_rank_norm
      WHEN 'flag'       THEN attribute_value_num * 100.0
    END AS normalized
  FROM ranked
)
SELECT * FROM contributions
WHERE normalized IS NOT NULL
"""

contributions_df = spark.sql(normalized_sql)
contributions_df.createOrReplaceTempView("v_contributions")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Step 2: aggregate to (hcp_key, tenant_id, scope_tag) composites. Plus
# a synthetic '__all__' aggregation row that averages across every scope.
# named_struct + collect_list + array_sort + slice gives us "top N
# contributors by normalized score" as a structured array, which we then
# serialize to JSON for storage.

aggregate_sql = f"""
WITH per_scope AS (
  SELECT
    hcp_key,
    tenant_id,
    scope_tag,
    AVG(normalized) AS score_value,
    COUNT(*) AS contributor_count,
    -- Sort contributors DESC by normalized then take top N. Spark's
    -- array_sort with a custom comparator returns ascending; reverse
    -- by sorting ASC then SLICE from the end... actually easier:
    -- use slice on a DESC-sorted array.
    SLICE(
      ARRAY_SORT(
        COLLECT_LIST(named_struct(
          'attribute_name', attribute_name,
          'raw_value',      attribute_value,
          'normalized',     ROUND(normalized, 1),
          'source_label',   source_label,
          'scope_tag',      scope_tag
        )),
        (a, b) -> CASE WHEN a.normalized > b.normalized THEN -1
                       WHEN a.normalized < b.normalized THEN 1
                       ELSE 0 END
      ),
      1, {TOP_CONTRIBUTORS}
    ) AS top_contributors
  FROM v_contributions
  GROUP BY hcp_key, tenant_id, scope_tag
),
-- Synthetic '__all__' scope: same calculation but ungrouped by scope_tag.
-- Yields the cross-therapy-area composite for "no preference" queries.
all_scope AS (
  SELECT
    hcp_key,
    tenant_id,
    '__all__' AS scope_tag,
    AVG(normalized) AS score_value,
    COUNT(*) AS contributor_count,
    SLICE(
      ARRAY_SORT(
        COLLECT_LIST(named_struct(
          'attribute_name', attribute_name,
          'raw_value',      attribute_value,
          'normalized',     ROUND(normalized, 1),
          'source_label',   source_label,
          'scope_tag',      scope_tag
        )),
        (a, b) -> CASE WHEN a.normalized > b.normalized THEN -1
                       WHEN a.normalized < b.normalized THEN 1
                       ELSE 0 END
      ),
      1, {TOP_CONTRIBUTORS}
    ) AS top_contributors
  FROM v_contributions
  GROUP BY hcp_key, tenant_id
)
SELECT
  hcp_key,
  tenant_id,
  scope_tag,
  ROUND(score_value, 2) AS score_value,
  CAST(contributor_count AS INT) AS contributor_count,
  TO_JSON(top_contributors) AS contributors,
  current_timestamp() AS gold_built_at
FROM per_scope
UNION ALL
SELECT
  hcp_key,
  tenant_id,
  scope_tag,
  ROUND(score_value, 2) AS score_value,
  CAST(contributor_count AS INT) AS contributor_count,
  TO_JSON(top_contributors) AS contributors,
  current_timestamp() AS gold_built_at
FROM all_scope
"""

result = spark.sql(aggregate_sql)
row_count = result.count()

(
    result.write
    .format("delta")
    .mode("overwrite")
    .option("overwriteSchema", "true")
    .saveAsTable(GOLD_SCORE)
)

print(f"Wrote {row_count:,} rows to {GOLD_SCORE}")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

print("=== Per-tenant counts + scope distribution ===")
spark.sql(f"""
  SELECT
    tenant_id,
    scope_tag,
    COUNT(*) AS hcps_scored,
    ROUND(MIN(score_value), 1) AS min_score,
    ROUND(AVG(score_value), 1) AS avg_score,
    ROUND(MAX(score_value), 1) AS max_score,
    ROUND(AVG(contributor_count), 1) AS avg_contributors
  FROM {GOLD_SCORE}
  GROUP BY tenant_id, scope_tag
  ORDER BY tenant_id, scope_tag
""").show(50, truncate=False)

print("=== Top 5 HCPs by '__all__' composite ===")
spark.sql(f"""
  SELECT s.tenant_id, s.hcp_key, h.name, h.specialty_primary, h.tier,
         s.score_value, s.contributor_count, s.contributors
  FROM {GOLD_SCORE} s
  LEFT JOIN gold.dim_hcp h
    ON h.hcp_key = s.hcp_key AND h.tenant_id = s.tenant_id
  WHERE s.scope_tag = '__all__'
  ORDER BY s.score_value DESC
  LIMIT 5
""").show(5, truncate=False, vertical=True)

print("=== Top 5 HCPs by cisplatin scope (fennec lead-indicator example) ===")
spark.sql(f"""
  SELECT s.tenant_id, s.hcp_key, h.name, h.specialty_primary, h.tier,
         s.score_value, s.contributor_count, s.contributors
  FROM {GOLD_SCORE} s
  LEFT JOIN gold.dim_hcp h
    ON h.hcp_key = s.hcp_key AND h.tenant_id = s.tenant_id
  WHERE s.scope_tag = 'cisplatin'
  ORDER BY s.score_value DESC
  LIMIT 5
""").show(5, truncate=False, vertical=True)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
