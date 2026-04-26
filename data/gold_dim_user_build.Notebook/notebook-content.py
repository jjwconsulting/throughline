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

# # Gold build: dim_user
# Star-schema user (sales rep / MSL / admin) dimension. Built from
# `silver.user`. Adds `user_key` (MD5 surrogate) for fact_call FK joins.
# Includes a derived `is_active_normalized` boolean — combines tenant-specific
# active-flag conventions (per `docs/architecture/tenant-variability.md`
# category 3). Today: fennec uses `status='Active'`. Tomorrow's tenants may
# use isactive__v; logic moves to a rule registry.

# CELL ********************

SILVER_TABLE = "silver.user"
GOLD_TABLE = "gold.dim_user"

spark.sql("CREATE SCHEMA IF NOT EXISTS gold")
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {GOLD_TABLE} (
  user_key             STRING    NOT NULL,
  tenant_id            STRING    NOT NULL,
  veeva_user_id        STRING    NOT NULL,
  source_system        STRING    NOT NULL,
  name                 STRING,
  first_name           STRING,
  last_name            STRING,
  email                STRING,
  username             STRING,
  employee_number      STRING,
  title                STRING,
  department           STRING,
  division             STRING,
  user_type            STRING,
  manager_id           STRING,
  status               STRING,
  is_active            BOOLEAN   NOT NULL,
  is_field_user        BOOLEAN   NOT NULL,
  activation_date      STRING,
  inactivation_date    STRING,
  gold_built_at        TIMESTAMP NOT NULL
) USING DELTA
""")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# is_active normalization: prefer `status` field (fennec convention), fall
# back to `isactive__v` literal. Will become tenant-config-driven per
# tenant-variability.md category 3.
result = spark.sql(f"""
SELECT
  md5(concat_ws('|', tenant_id, veeva_user_id))  AS user_key,
  tenant_id,
  veeva_user_id,
  source_system,
  name,
  first_name,
  last_name,
  email,
  username,
  employee_number,
  title,
  department,
  division,
  user_type,
  manager_id,
  status,
  CASE
    WHEN LOWER(status)    = 'active' THEN TRUE
    WHEN LOWER(status)    = 'inactive' THEN FALSE
    WHEN LOWER(is_active) = 'true' THEN TRUE
    WHEN LOWER(is_active) = 'false' THEN FALSE
    ELSE FALSE
  END AS is_active,
  -- Strips system/integration accounts (Application Owner, Java SDK, etc.)
  -- which have user_type = NULL despite status = 'Active'. Reports filter
  -- on is_field_user for "real reps only" views.
  CASE
    WHEN user_type IN ('Sales', 'Medical') THEN TRUE
    ELSE FALSE
  END AS is_field_user,
  activation_date,
  inactivation_date,
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

print("=== Active vs inactive ===")
spark.sql(f"""
  SELECT is_active, COUNT(*) AS n
  FROM {GOLD_TABLE}
  GROUP BY is_active
""").show(truncate=False)

print("=== Sample 5 active reps ===")
spark.sql(f"""
  SELECT user_key, name, email, title, user_type, is_active
  FROM {GOLD_TABLE}
  WHERE is_active = TRUE
  LIMIT 5
""").show(truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
