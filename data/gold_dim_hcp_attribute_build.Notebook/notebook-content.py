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

# # Gold build: dim_hcp_attribute
# Long-format star-dimension for HCP scoring attributes. Built from
# `silver.hcp_attribute` joined to `gold.dim_hcp` for the surrogate
# `hcp_key`. Adds:
#   - **`attribute_key`** — MD5 surrogate (tenant + hcp + attribute_name).
#     Stable across rebuilds; suitable for any future attribute-level
#     fact joins (e.g. fact_attribute_history).
#   - **`hcp_key`** — joins gold.dim_hcp directly. Rows where the silver
#     hcp_id has no matching dim_hcp (filtered, deleted) are DROPPED —
#     scoring an HCP that doesn't exist in our dim is meaningless.
#   - **`attribute_value_num`** — numeric parse of the raw value, NULL
#     for `categorical` type. Composite scoring math reads from this.
#     Bad parses (non-numeric value declared as numeric type) → NULL +
#     warning row in the verification output.
#
# Build dependency: gold.dim_hcp + silver.hcp_attribute. Sequence the
# orchestrator: silver_hcp_attribute_build → gold_dim_hcp_build →
# gold_dim_hcp_attribute_build.

# CELL ********************

SILVER_TABLE = "silver.hcp_attribute"
GOLD_TABLE = "gold.dim_hcp_attribute"

spark.sql("CREATE SCHEMA IF NOT EXISTS gold")
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {GOLD_TABLE} (
  attribute_key       STRING    NOT NULL,
  hcp_key             STRING    NOT NULL,
  tenant_id           STRING    NOT NULL,
  attribute_name      STRING    NOT NULL,
  -- Raw string value as it lands in silver. Always populated.
  attribute_value     STRING,
  -- Parsed double for numeric types (decile, score, volume, percentile,
  -- flag-as-0-or-1). NULL for categorical OR when parse fails.
  attribute_value_num DOUBLE,
  attribute_type      STRING    NOT NULL,
  source_system       STRING    NOT NULL,
  source_label        STRING    NOT NULL,
  scope_tag           STRING,
  valid_as_of         DATE,
  gold_built_at       TIMESTAMP NOT NULL
) USING DELTA
""")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Parse logic per attribute_type:
#   - decile/score/volume/percentile → TRY_CAST AS DOUBLE
#   - flag → CASE for common boolean spellings → 0.0 / 1.0
#   - categorical → NULL (composite scoring skips; LLM consumes raw value)
# TRY_CAST returns NULL on parse failure (vs CAST which raises) — that's
# the desired behavior; the verification cell flags any unexpected NULLs.

result = spark.sql(f"""
SELECT
  md5(concat_ws('|', s.tenant_id, s.hcp_id, s.attribute_name)) AS attribute_key,
  h.hcp_key,
  s.tenant_id,
  s.attribute_name,
  s.attribute_value,
  CASE s.attribute_type
    WHEN 'decile'      THEN TRY_CAST(s.attribute_value AS DOUBLE)
    WHEN 'score'       THEN TRY_CAST(s.attribute_value AS DOUBLE)
    WHEN 'volume'      THEN TRY_CAST(s.attribute_value AS DOUBLE)
    WHEN 'percentile'  THEN TRY_CAST(s.attribute_value AS DOUBLE)
    WHEN 'flag' THEN
      CASE LOWER(TRIM(s.attribute_value))
        WHEN 'true'  THEN 1.0
        WHEN 't'     THEN 1.0
        WHEN '1'     THEN 1.0
        WHEN 'yes'   THEN 1.0
        WHEN 'y'     THEN 1.0
        WHEN 'false' THEN 0.0
        WHEN 'f'     THEN 0.0
        WHEN '0'     THEN 0.0
        WHEN 'no'    THEN 0.0
        WHEN 'n'     THEN 0.0
        ELSE NULL
      END
    ELSE NULL                            -- categorical, anything unrecognized
  END AS attribute_value_num,
  s.attribute_type,
  s.source_system,
  s.source_label,
  s.scope_tag,
  s.valid_as_of,
  current_timestamp() AS gold_built_at
FROM {SILVER_TABLE} s
JOIN gold.dim_hcp h
  ON h.tenant_id = s.tenant_id
  AND h.veeva_account_id = s.hcp_id
""")
row_count = result.count()

(
    result.write
    .format("delta")
    .mode("overwrite")
    .option("overwriteSchema", "true")
    .saveAsTable(GOLD_TABLE)
)

print(f"Wrote {row_count:,} rows to {GOLD_TABLE}")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Verification

print("=== Per-tenant counts + dim_hcp join coverage ===")
spark.sql(f"""
  SELECT
    g.tenant_id,
    COUNT(*) AS gold_rows,
    COUNT(DISTINCT g.hcp_key) AS hcps_with_attrs,
    (SELECT COUNT(*) FROM {SILVER_TABLE} s WHERE s.tenant_id = g.tenant_id) AS silver_rows,
    ROUND(
      100.0 * COUNT(*) /
      NULLIF((SELECT COUNT(*) FROM {SILVER_TABLE} s WHERE s.tenant_id = g.tenant_id), 0),
      1
    ) AS pct_silver_resolved_to_dim
  FROM {GOLD_TABLE} g
  GROUP BY g.tenant_id
  ORDER BY g.tenant_id
""").show(truncate=False)

print("=== Numeric parse health (numeric types: count + null-num count) ===")
spark.sql(f"""
  SELECT
    attribute_type,
    COUNT(*) AS total,
    SUM(CASE WHEN attribute_value_num IS NULL THEN 1 ELSE 0 END) AS num_null,
    ROUND(100.0 * SUM(CASE WHEN attribute_value_num IS NULL THEN 1 ELSE 0 END) / COUNT(*), 2) AS pct_null
  FROM {GOLD_TABLE}
  GROUP BY attribute_type
  ORDER BY total DESC
""").show(truncate=False)

print("=== Per-attribute distribution (sample) ===")
spark.sql(f"""
  SELECT
    attribute_name,
    attribute_type,
    scope_tag,
    COUNT(*) AS rows,
    ROUND(MIN(attribute_value_num), 2) AS min_v,
    ROUND(AVG(attribute_value_num), 2) AS avg_v,
    ROUND(MAX(attribute_value_num), 2) AS max_v
  FROM {GOLD_TABLE}
  WHERE attribute_value_num IS NOT NULL
  GROUP BY attribute_name, attribute_type, scope_tag
  ORDER BY attribute_name
""").show(50, truncate=False)

print("=== Sample 5 rows ===")
spark.sql(f"""
  SELECT hcp_key, attribute_name, attribute_value, attribute_value_num, attribute_type, source_label, scope_tag
  FROM {GOLD_TABLE}
  LIMIT 5
""").show(truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
