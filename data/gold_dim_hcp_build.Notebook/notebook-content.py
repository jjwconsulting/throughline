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
# Star-schema HCP dimension. Built from `silver.hcp`. Adds:
#   - **`hcp_key`** — deterministic MD5 surrogate key (tenant_id + veeva_account_id).
#     Stable across rebuilds, suitable for fact_call FK joins.
#   - **`primary_parent_hco_key`** — surrogate of the HCP's primary parent HCO
#     (Veeva's account.primary_parent__v). Computed using the same MD5
#     formula as dim_hco.hco_key so downstream surfaces can group HCPs by
#     affiliation without a runtime JOIN.
#   - **`primary_parent_hco_name`** — denormalized parent HCO name from
#     LEFT JOIN to dim_hco. NULL when the parent_account_id points at an
#     HCO that's been filtered out of dim_hco (deleted / inactive / etc.)
#     — the surrogate key is still populated so a re-resolve is possible.
# Otherwise mostly a passthrough projection — silver.hcp is already clean,
# deduped, and picklist-translated. Gold's job here is the surrogate keys
# and dropping silver-internal columns.
#
# Build dependency: gold.dim_hco must be built before this notebook so
# the parent-name LEFT JOIN finds rows. The orchestrators sequence
# dim_hco → dim_hcp; running standalone, run dim_hco first.

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
  -- HCO affiliation (Veeva primary_parent__v). Raw account_id from
  -- silver, plus the resolved surrogate key + name from dim_hco.
  primary_parent_account_id STRING,
  primary_parent_hco_key    STRING,
  primary_parent_hco_name   STRING,
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
  md5(concat_ws('|', s.tenant_id, s.veeva_account_id))  AS hcp_key,
  s.tenant_id,
  s.veeva_account_id,
  s.network_id,
  s.dea_number,
  s.source_system,
  s.npi,
  s.name,
  s.first_name,
  s.last_name,
  s.credentials,
  s.specialty_primary,
  s.specialty_secondary,
  s.gender,
  s.email,
  s.city,
  s.state,
  s.postal_code,
  s.country,
  s.is_prescriber,
  s.is_kol,
  s.is_speaker,
  s.status,
  s.tier,
  s.account_type,
  s.source_id,
  s.primary_parent_account_id,
  -- Compute parent HCO surrogate key with the same MD5 formula
  -- dim_hco uses, so JOINs from this column to dim_hco.hco_key
  -- work without an extra resolve step elsewhere.
  CASE
    WHEN s.primary_parent_account_id IS NOT NULL AND s.primary_parent_account_id <> ''
    THEN md5(concat_ws('|', s.tenant_id, s.primary_parent_account_id))
    ELSE NULL
  END AS primary_parent_hco_key,
  -- LEFT JOIN to dim_hco for the readable name. NULL when the parent
  -- HCO is missing from dim_hco (filtered, deleted, etc.) — surrogate
  -- key above stays populated so the link can be re-resolved later.
  hco.name AS primary_parent_hco_name,
  current_timestamp() AS gold_built_at
FROM {SILVER_TABLE} s
LEFT JOIN gold.dim_hco hco
  ON hco.tenant_id = s.tenant_id
  AND hco.hco_key = md5(concat_ws('|', s.tenant_id, s.primary_parent_account_id))
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

print("=== HCO affiliation coverage ===")
spark.sql(f"""
  SELECT
    COUNT(*) AS total_hcps,
    SUM(CASE WHEN primary_parent_hco_key IS NOT NULL THEN 1 ELSE 0 END) AS with_parent_key,
    SUM(CASE WHEN primary_parent_hco_name IS NOT NULL THEN 1 ELSE 0 END) AS with_parent_name,
    ROUND(
      100.0 * SUM(CASE WHEN primary_parent_hco_name IS NOT NULL THEN 1 ELSE 0 END)
      / COUNT(*),
      1
    ) AS pct_with_resolved_name
  FROM {GOLD_TABLE}
""").show(truncate=False)

print("=== Sample 5 affiliated HCPs ===")
spark.sql(f"""
  SELECT name, primary_parent_hco_name
  FROM {GOLD_TABLE}
  WHERE primary_parent_hco_name IS NOT NULL
  LIMIT 5
""").show(truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
