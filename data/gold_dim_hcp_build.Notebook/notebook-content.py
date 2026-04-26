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

# # Gold build: dim_hcp
#
# Star-schema HCP dimension. Built from `silver.hcp`. Adds:
#   - **`hcp_key`** — deterministic MD5 surrogate key (tenant_id + veeva_account_id).
#     Stable across rebuilds, suitable for fact_call FK joins.
#
# Otherwise mostly a passthrough projection — silver.hcp is already clean,
# deduped, and picklist-translated. Gold's job here is mainly the surrogate
# key and dropping silver-internal columns.

# CELL ********************

SILVER_TABLE = "silver.hcp"
GOLD_TABLE = "gold.dim_hcp"

spark.sql("CREATE SCHEMA IF NOT EXISTS gold")
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {GOLD_TABLE} (
  hcp_key              STRING    NOT NULL,
  tenant_id            STRING    NOT NULL,
  -- Identifier columns. veeva_account_id is the CRM record id (always
  -- present); network_id, npi, dea_number are nullable alternates used by
  -- the mapping uploader's multi-field resolution. NPI is universal for
  -- HCPs; Network ID is the canonical cross-system pharma master-data
  -- spine; DEA only for prescribers of controlled substances.
  veeva_account_id     STRING    NOT NULL,
  network_id           STRING,
  dea_number           STRING,
  source_system        STRING    NOT NULL,
  npi                  STRING,
  name                 STRING,
  first_name           STRING,
  last_name            STRING,
  credentials          STRING,
  specialty_primary    STRING,
  specialty_secondary  STRING,
  gender               STRING,
  email                STRING,
  city                 STRING,
  state                STRING,
  postal_code          STRING,
  country              STRING,
  is_prescriber        STRING,
  is_kol               STRING,
  is_speaker           STRING,
  status               STRING,
  tier                 STRING,
  account_type         STRING,
  source_id            STRING,
  gold_built_at        TIMESTAMP NOT NULL
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
  md5(concat_ws('|', tenant_id, veeva_account_id))  AS hcp_key,
  tenant_id,
  veeva_account_id,
  network_id,
  dea_number,
  source_system,
  npi,
  name,
  first_name,
  last_name,
  credentials,
  specialty_primary,
  specialty_secondary,
  gender,
  email,
  city,
  state,
  postal_code,
  country,
  is_prescriber,
  is_kol,
  is_speaker,
  status,
  tier,
  account_type,
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
  SELECT hcp_key, name, npi, specialty_primary, state, tier, status
  FROM {GOLD_TABLE}
  LIMIT 5
""").show(truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
