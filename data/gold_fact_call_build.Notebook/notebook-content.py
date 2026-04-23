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

# # Gold build: fact_call
#
# Central pharma fact: one row per call event. Built from `silver.call` with
# foreign keys resolved into surrogate dim keys for clean star-schema joins.
#
# FK resolution:
#   - account → dim_hcp (and/or dim_hco when we add it). HCPs first; if no
#     match, account_key stays NULL — calls on HCOs not yet dim'd. Later
#     we'll add dim_hco and resolve both.
#   - owner_user, attributed_user → dim_user
#   - call_date → dim_date
#
# Both `owner_user_key` and `attributed_user_key` populated. PBI sets up
# two relationships from fact_call → dim_user; reports use USERELATIONSHIP()
# to swap perspectives ("rep credit" vs "record owner").
#
# Skips territory FK for v1 — that needs SCD2 user_territory for
# point-in-time accuracy. Reports drag dim_user → silver.user_territory →
# silver.territory in PBI for current-state attribution. Promote to gold
# when SCD2 lands.
#
# Measures: call_count (always 1; PBI sums) + duration_minutes (cast from
# silver string).

# CELL ********************

GOLD_TABLE = "gold.fact_call"

spark.sql("CREATE SCHEMA IF NOT EXISTS gold")
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {GOLD_TABLE} (
  call_key                STRING    NOT NULL,
  tenant_id               STRING    NOT NULL,
  veeva_call_id           STRING    NOT NULL,
  hcp_key                 STRING,
  owner_user_key          STRING,
  attributed_user_key     STRING,
  credit_user_key         STRING,
  call_date_key           INT,
  call_date               DATE,
  call_datetime           TIMESTAMP,
  call_type               STRING,
  call_channel            STRING,
  call_status             STRING,
  status                  STRING,
  is_remote_meeting       STRING,
  is_sampled_call         STRING,
  duration_minutes        DOUBLE,
  call_count              INT       NOT NULL,
  city                    STRING,
  state                   STRING,
  detailed_products       STRING,
  product_priority_1      STRING,
  product_priority_2      STRING,
  product_priority_3      STRING,
  materials_used          STRING,
  msl_materials_used      STRING,
  source_system           STRING    NOT NULL,
  gold_built_at           TIMESTAMP NOT NULL
) USING DELTA
""")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# JOIN strategy: LEFT JOIN to all dims so calls survive even if a dim row is
# missing (e.g., owner_user_id points to a deleted rep). The orphaned FK
# becomes NULL — PBI treats as "Unknown" group, surfaces as a data quality
# signal in the dashboard.
build_sql = f"""
SELECT
  md5(concat_ws('|', c.tenant_id, c.veeva_call_id))  AS call_key,
  c.tenant_id,
  c.veeva_call_id,
  hcp.hcp_key,
  owner.user_key AS owner_user_key,
  attr.user_key  AS attributed_user_key,
  -- Default rep attribution: prefer attributed (user__v) when set, fall back
  -- to owner (ownerid__v). Fennec leaves user__v blank on most calls and uses
  -- owner as the credit field. Other tenants may populate user__v reliably.
  -- This is fennec-aware logic that will move to a tenant-config rule when
  -- tenant #2 lands (see docs/architecture/tenant-variability.md cat 3).
  COALESCE(attr.user_key, owner.user_key) AS credit_user_key,
  CAST(date_format(TRY_CAST(c.call_date AS DATE), 'yyyyMMdd') AS INT) AS call_date_key,
  TRY_CAST(c.call_date AS DATE)            AS call_date,
  TRY_CAST(c.call_datetime AS TIMESTAMP)   AS call_datetime,
  c.call_type,
  c.call_channel,
  c.call_status,
  c.status,
  c.is_remote_meeting,
  c.is_sampled_call,
  TRY_CAST(c.duration AS DOUBLE)           AS duration_minutes,
  1                                        AS call_count,
  c.city,
  c.state,
  c.detailed_products,
  c.product_priority_1,
  c.product_priority_2,
  c.product_priority_3,
  c.materials_used,
  c.msl_materials_used,
  c.source_system,
  current_timestamp()                      AS gold_built_at
FROM silver.call c
LEFT JOIN gold.dim_hcp hcp
  ON hcp.tenant_id = c.tenant_id
  AND hcp.veeva_account_id = c.account_id
LEFT JOIN gold.dim_user owner
  ON owner.tenant_id = c.tenant_id
  AND owner.veeva_user_id = c.owner_user_id
LEFT JOIN gold.dim_user attr
  ON attr.tenant_id = c.tenant_id
  AND attr.veeva_user_id = c.user_id
"""

result = spark.sql(build_sql)
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

# Verification: how many calls actually resolved each FK?
print("=== FK resolution rates ===")
spark.sql(f"""
  SELECT
    COUNT(*) AS total_calls,
    SUM(CASE WHEN hcp_key IS NOT NULL THEN 1 ELSE 0 END)              AS with_hcp,
    SUM(CASE WHEN owner_user_key IS NOT NULL THEN 1 ELSE 0 END)       AS with_owner_user,
    SUM(CASE WHEN attributed_user_key IS NOT NULL THEN 1 ELSE 0 END)  AS with_attributed_user,
    SUM(CASE WHEN call_date_key IS NOT NULL THEN 1 ELSE 0 END)        AS with_call_date,
    SUM(CASE WHEN duration_minutes IS NOT NULL THEN 1 ELSE 0 END)     AS with_duration
  FROM {GOLD_TABLE}
""").show(truncate=False)

print("=== Calls by year-quarter ===")
spark.sql(f"""
  SELECT d.year_quarter, COUNT(*) AS calls
  FROM {GOLD_TABLE} f
  JOIN gold.dim_date d ON d.date_key = f.call_date_key
  GROUP BY d.year_quarter
  ORDER BY d.year_quarter
""").show(20, truncate=False)

print("=== Top 10 reps by call count (using credit_user_key) ===")
spark.sql(f"""
  SELECT u.name AS rep, COUNT(*) AS calls, ROUND(AVG(f.duration_minutes), 1) AS avg_duration
  FROM {GOLD_TABLE} f
  JOIN gold.dim_user u ON u.user_key = f.credit_user_key
  WHERE u.is_field_user = TRUE
  GROUP BY u.name
  ORDER BY calls DESC
""").show(10, truncate=False)

print("=== Top 10 specialties by calls received ===")
spark.sql(f"""
  SELECT h.specialty_primary, COUNT(*) AS calls
  FROM {GOLD_TABLE} f
  JOIN gold.dim_hcp h ON h.hcp_key = f.hcp_key
  GROUP BY h.specialty_primary
  ORDER BY calls DESC
""").show(10, truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
