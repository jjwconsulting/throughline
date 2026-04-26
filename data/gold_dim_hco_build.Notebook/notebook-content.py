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

# # Gold build: dim_hco
# Star-schema HCO (institution / organization) dimension. Built from
# `silver.hco`. Mirrors `gold.dim_hcp` shape:
#   - **`hco_key`** — deterministic MD5 surrogate key (tenant_id + veeva_account_id).
#     Stable across rebuilds; used as FK from `fact_call.hco_key` for
#     organization-account calls.
# Mostly a passthrough projection. silver.hco is already clean, deduped,
# and picklist-translated.

# CELL ********************

SILVER_TABLE = "silver.hco"
GOLD_TABLE = "gold.dim_hco"

spark.sql("CREATE SCHEMA IF NOT EXISTS gold")
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {GOLD_TABLE} (
  hco_key               STRING    NOT NULL,
  tenant_id             STRING    NOT NULL,
  -- Identifier columns. veeva_account_id is the CRM record id (always
  -- present); network_id, npi, dea_number, aha_id, tax_id are nullable
  -- alternates used by the mapping uploader's multi-field resolution to
  -- accept distributor↔Veeva files keyed off any of these.
  veeva_account_id      STRING    NOT NULL,
  network_id            STRING,
  npi                   STRING,
  dea_number            STRING,
  source_system         STRING    NOT NULL,
  name                  STRING,
  hco_type              STRING,
  hospital_type         STRING,
  hco_class             STRING,
  account_group         STRING,
  aha_id                STRING,
  bed_count             STRING,
  email                 STRING,
  phone_office          STRING,
  city                  STRING,
  state                 STRING,
  postal_code           STRING,
  country               STRING,
  parent_account_id     STRING,
  status                STRING,
  segmentation          STRING,
  tier                  STRING,
  account_type          STRING,
  focus_area_1          STRING,
  major_class_of_trade  STRING,
  tax_id                STRING,
  source_id             STRING,
  gold_built_at         TIMESTAMP NOT NULL
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
  md5(concat_ws('|', tenant_id, veeva_account_id))  AS hco_key,
  tenant_id,
  veeva_account_id,
  network_id,
  npi,
  dea_number,
  source_system,
  name,
  hco_type,
  hospital_type,
  hco_class,
  account_group,
  aha_id,
  bed_count,
  email,
  phone_office,
  city,
  state,
  postal_code,
  country,
  parent_account_id,
  status,
  segmentation,
  tier,
  account_type,
  focus_area_1,
  major_class_of_trade,
  tax_id,
  source_id,
  current_timestamp() AS gold_built_at
FROM {SILVER_TABLE}
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

print("=== Sample 5 rows ===")
spark.sql(f"""
  SELECT hco_key, name, hco_type, city, state, tier, status
  FROM {GOLD_TABLE}
  LIMIT 5
""").show(truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
