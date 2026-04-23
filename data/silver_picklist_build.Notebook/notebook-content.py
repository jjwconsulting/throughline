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

# # Silver build: picklist
#
# Cross-cutting lookup table built from each tenant's
# `bronze_<slug>.veeva_pl_picklist__sys`. Maps
# `(tenant_id, object, field, code)` → `label` so other silver builds can
# translate Veeva picklist codes to human-readable display values.
#
# `picklist__sys` carries incremental history like every other Veeva object,
# so we dedup by `(object, object_field, picklist_value_name)` keeping the
# latest `modified_date__v`.
#
# Both active and inactive picklist values are kept — older bronze rows may
# reference codes that have since been deactivated, and we still want to
# resolve them.
#
# Run BEFORE any silver build that needs picklist translation
# (silver_hcp_build, silver_hco_build, etc.). Schedule daily after
# veeva_full_ingest in prod.

# CELL ********************

SILVER_TABLE = "silver.picklist"

spark.sql("CREATE SCHEMA IF NOT EXISTS silver")
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {SILVER_TABLE} (
  tenant_id        STRING    NOT NULL,
  object           STRING    NOT NULL,
  field            STRING    NOT NULL,
  code             STRING    NOT NULL,
  label            STRING    NOT NULL,
  status           STRING,
  silver_built_at  TIMESTAMP NOT NULL
) USING DELTA
""")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

def slug_to_schema(slug: str) -> str:
    return slug.replace("-", "_")


# Build per-tenant SELECTs: dedup the bronze picklist__sys by latest
# modified_date__v, project into the silver shape, stamp tenant_id.
def build_tenant_select(tenant_id: str, slug: str) -> str:
    bronze_table = f"bronze_{slug_to_schema(slug)}.veeva_pl_picklist__sys"
    return f"""
WITH ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY object, object_field, picklist_value_name
      ORDER BY modified_date__v DESC NULLS LAST, _ingested_at DESC
    ) AS _rn
  FROM {bronze_table}
)
SELECT
  '{tenant_id}'                AS tenant_id,
  ranked.object                AS object,
  ranked.object_field          AS field,
  ranked.picklist_value_name   AS code,
  ranked.picklist_value_label  AS label,
  ranked.status__v             AS status,
  current_timestamp()          AS silver_built_at
FROM ranked
WHERE _rn = 1
"""


# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Find tenants with a Veeva integration
tenants = [
    r.asDict() for r in spark.sql("""
      SELECT t.id, t.slug
      FROM config.tenant t
      JOIN config.tenant_veeva tv ON tv.tenant_id = t.id
      WHERE t.status = 'active' AND tv.enabled = true
    """).collect()
]
print(f"Tenants with Veeva picklist data: {[t['slug'] for t in tenants] or '(none)'}")

if not tenants:
    raise RuntimeError("No active Veeva tenants. Run veeva_full_ingest first.")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# UNION across tenants and write
union_sql = "\nUNION ALL\n".join(
    f"({build_tenant_select(t['id'], t['slug'])})" for t in tenants
)

result_df = spark.sql(union_sql)
row_count = result_df.count()

(
    result_df.write
    .format("delta")
    .mode("overwrite")
    .option("overwriteSchema", "true")
    .saveAsTable(SILVER_TABLE)
)

print(f"Wrote {row_count:,} rows to {SILVER_TABLE}")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Verification
print("=== Per-tenant counts ===")
spark.sql(f"""
  SELECT tenant_id, COUNT(*) AS values, COUNT(DISTINCT object) AS objects, COUNT(DISTINCT object || '|' || field) AS fields
  FROM {SILVER_TABLE}
  GROUP BY tenant_id
""").show(truncate=False)

print("=== Top objects by picklist value count ===")
spark.sql(f"""
  SELECT object, COUNT(*) AS values
  FROM {SILVER_TABLE}
  GROUP BY object
  ORDER BY values DESC
""").show(20, truncate=False)

print("=== Sample translations (account__v) ===")
spark.sql(f"""
  SELECT field, code, label, status
  FROM {SILVER_TABLE}
  WHERE object = 'account__v'
  ORDER BY field, code
  LIMIT 30
""").show(truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
