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

# # Gold build: dim_hco_attribute
# Long-format star-dimension for HCO scoring attributes. Mirror of
# `gold_dim_hcp_attribute_build` but joined to `gold.dim_hco`. See that
# notebook for the parsing-rule narrative + verification rationale.
#
# Fennec data today has all attributes mapped at HCP-grain (Komodo per-
# physician deciles), so this notebook will write 0 rows on first run.
# Symmetry with the HCP build means TriSalus' Clarivate per-HCO volumes
# (when they ingest) flow through the same path with no further code.

# CELL ********************

SILVER_TABLE = "silver.hco_attribute"
GOLD_TABLE = "gold.dim_hco_attribute"

spark.sql("CREATE SCHEMA IF NOT EXISTS gold")
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {GOLD_TABLE} (
  attribute_key       STRING    NOT NULL,
  hco_key             STRING    NOT NULL,
  tenant_id           STRING    NOT NULL,
  attribute_name      STRING    NOT NULL,
  attribute_value     STRING,
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

result = spark.sql(f"""
SELECT
  md5(concat_ws('|', s.tenant_id, s.hco_id, s.attribute_name)) AS attribute_key,
  h.hco_key,
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
    ELSE NULL
  END AS attribute_value_num,
  s.attribute_type,
  s.source_system,
  s.source_label,
  s.scope_tag,
  s.valid_as_of,
  current_timestamp() AS gold_built_at
FROM {SILVER_TABLE} s
JOIN gold.dim_hco h
  ON h.tenant_id = s.tenant_id
  AND h.veeva_account_id = s.hco_id
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

print("=== Per-tenant counts ===")
spark.sql(f"""
  SELECT tenant_id, COUNT(*) AS rows,
         COUNT(DISTINCT hco_key) AS hcos_with_attrs,
         COUNT(DISTINCT attribute_name) AS distinct_attrs
  FROM {GOLD_TABLE}
  GROUP BY tenant_id
  ORDER BY tenant_id
""").show(truncate=False)

print("=== Per-attribute distribution ===")
spark.sql(f"""
  SELECT attribute_name, attribute_type, scope_tag, COUNT(*) AS rows,
         ROUND(MIN(attribute_value_num), 2) AS min_v,
         ROUND(AVG(attribute_value_num), 2) AS avg_v,
         ROUND(MAX(attribute_value_num), 2) AS max_v
  FROM {GOLD_TABLE}
  WHERE attribute_value_num IS NOT NULL
  GROUP BY attribute_name, attribute_type, scope_tag
  ORDER BY attribute_name
""").show(50, truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
