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

# # Gold build: dim_hcp_score_wide
# Per-tenant pivoted view of numeric HCP scoring attributes. One row per
# (tenant, hcp_key); one column per active numeric attribute_name. Built
# from `gold.dim_hcp_attribute` filtered to numeric types.
#
# Why pivot: the long format in dim_hcp_attribute is flexible but slow
# to JOIN from fact tables / loaders that want "give me this HCP's
# breast_cancer_decile + cisplatin_volume + tier alongside their call
# count." A wide view materializes that lookup as a single join. The
# rep-recommendations LLM input loader (lib/hcp-target-scores.ts) reads
# from this table directly.
#
# Schema generation: column list is derived from `config.tenant_attribute_map`
# (active rows only, numeric types only). When admins add a new attribute
# at /admin/attributes, the next pipeline run re-pivots and the new column
# appears automatically (overwriteSchema=true).
#
# Cross-tenant column union: this table holds rows from ALL tenants, with
# a column for every attribute that ANY tenant has active. Tenants that
# don't have a given attribute get NULL in that column. RLS at consumption
# (loaders filter on tenant_id) keeps tenants from seeing each other's
# data shapes.
#
# Build dependency: gold.dim_hcp_attribute. Sequence after the long-format
# build in the orchestrator.

# CELL ********************

GOLD_LONG = "gold.dim_hcp_attribute"
GOLD_WIDE = "gold.dim_hcp_score_wide"

NUMERIC_TYPES = ["decile", "score", "volume", "percentile", "flag"]

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Discover the active numeric attribute_name set across all tenants.
# This drives the pivot column list.
attr_names_rows = spark.sql(f"""
  SELECT DISTINCT m.attribute_name
  FROM config.tenant_attribute_map m
  JOIN config.tenant t ON t.id = m.tenant_id
  WHERE m.entity_type = 'hcp'
    AND m.active = true
    AND m.attribute_type IN ({", ".join(f"'{t}'" for t in NUMERIC_TYPES)})
    AND t.status = 'active'
  ORDER BY m.attribute_name
""").collect()

attribute_names = [r.attribute_name for r in attr_names_rows]
print(f"Active numeric HCP attributes to pivot: {len(attribute_names)}")
for name in attribute_names:
    print(f"  - {name}")

if not attribute_names:
    print("⚠ No active numeric HCP attributes. Writing empty wide table.")
    spark.sql(f"""
      CREATE OR REPLACE TABLE {GOLD_WIDE} AS
      SELECT
        CAST(NULL AS STRING)    AS hcp_key,
        CAST(NULL AS STRING)    AS tenant_id,
        CAST(NULL AS TIMESTAMP) AS gold_built_at
      WHERE 1 = 0
    """)
    mssparkutils.notebook.exit("no_numeric_attributes")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

def safe_column(name: str) -> str:
    """Sanitize attribute_name for use as a Delta column name. Most names
    are already snake_case (admin form auto-suggests that shape) but
    defend against leading digits / weird chars by quoting in backticks
    and replacing problem chars."""
    cleaned = "".join(c if c.isalnum() or c == "_" else "_" for c in name)
    if cleaned and cleaned[0].isdigit():
        cleaned = f"a_{cleaned}"
    return cleaned


# Generate per-attribute MAX(CASE WHEN ...) projections. MAX over the
# CASE handles dim_hcp_attribute's one-row-per-attribute shape — there's
# only one row per (hcp, attribute_name) so MAX is a no-op aggregator
# that Spark requires for the GROUP BY.
projections = []
for name in attribute_names:
    col = safe_column(name)
    projections.append(
        f"  MAX(CASE WHEN attribute_name = '{name}' THEN attribute_value_num END) AS {col}"
    )

pivot_sql = f"""
SELECT
  hcp_key,
  tenant_id,
{','.join(chr(10) + p for p in projections)},
  current_timestamp() AS gold_built_at
FROM {GOLD_LONG}
WHERE attribute_value_num IS NOT NULL
GROUP BY hcp_key, tenant_id
"""

print("=== Generated pivot SQL ===")
preview = pivot_sql if len(pivot_sql) < 4000 else pivot_sql[:4000] + "\n... [truncated]"
print(preview)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

result = spark.sql(pivot_sql)
row_count = result.count()

(
    result.write
    .format("delta")
    .mode("overwrite")
    .option("overwriteSchema", "true")
    .saveAsTable(GOLD_WIDE)
)

print(f"Wrote {row_count:,} rows to {GOLD_WIDE} ({len(attribute_names)} attribute columns)")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

print("=== Per-tenant row counts ===")
spark.sql(f"""
  SELECT tenant_id, COUNT(*) AS hcps_with_any_score
  FROM {GOLD_WIDE}
  GROUP BY tenant_id
  ORDER BY tenant_id
""").show(truncate=False)

print("=== Per-attribute fill rate ===")
fill_rate_projections = []
for name in attribute_names:
    col = safe_column(name)
    fill_rate_projections.append(
        f"SUM(CASE WHEN {col} IS NOT NULL THEN 1 ELSE 0 END) AS filled_{col}"
    )
spark.sql(f"""
  SELECT
    tenant_id,
    COUNT(*) AS total,
    {', '.join(fill_rate_projections)}
  FROM {GOLD_WIDE}
  GROUP BY tenant_id
""").show(truncate=False, vertical=True)

print("=== Sample 5 rows (limited columns) ===")
spark.sql(f"""
  SELECT *
  FROM {GOLD_WIDE}
  LIMIT 5
""").show(5, truncate=False, vertical=True)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
