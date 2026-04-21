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

# # Gold build: dim_account
#
# First gold table. Derived from silver.account_xref. Establishes the gold
# pattern ahead of real Veeva data — once Vault data lands, this gets
# replaced by a dim built from Veeva's account master with account_xref
# becoming a bridge.
#
# Shape: one row per (tenant_id, veeva_account_id). Where multiple source
# keys from silver resolve to the same Veeva account, attributes (name,
# channel, city, state) are collapsed via first().
#
# v0 scope: enough to drive a Power BI semantic model + one basic report.
# No facts, no measures beyond count. The validation target is embed + RLS,
# not business analytics.

# CELL ********************

GOLD_TABLE = "gold.dim_account"
SILVER_TABLE = "silver.account_xref"

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

spark.sql("CREATE SCHEMA IF NOT EXISTS gold")
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {GOLD_TABLE} (
  tenant_id          STRING    NOT NULL,
  account_key        STRING    NOT NULL,
  veeva_account_id   STRING    NOT NULL,
  name               STRING,
  channel            STRING,
  city               STRING,
  state              STRING,
  source_key_count   INT       NOT NULL,
  gold_built_at      TIMESTAMP NOT NULL
) USING DELTA
""")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Build from silver. GROUP BY (tenant_id, veeva_account_id) — the business
# identity of an account in the dim. Generate a deterministic account_key
# via MD5 so re-runs produce stable surrogate keys (unlike uuid() which
# would change every run).
build_sql = f"""
SELECT
  tenant_id,
  md5(concat_ws('|', tenant_id, veeva_account_id))  AS account_key,
  veeva_account_id,
  first(name)    AS name,
  first(channel) AS channel,
  first(city)    AS city,
  first(state)   AS state,
  COUNT(*)       AS source_key_count,
  current_timestamp() AS gold_built_at
FROM {SILVER_TABLE}
GROUP BY tenant_id, veeva_account_id
"""

result_df = spark.sql(build_sql)
row_count = result_df.count()

(
    result_df.write
    .format("delta")
    .mode("overwrite")
    .saveAsTable(GOLD_TABLE)
)

print(f"Wrote {row_count} rows to {GOLD_TABLE}")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

print("\n=== Sample ===")
spark.sql(f"""
  SELECT tenant_id, account_key, veeva_account_id, name, channel, state, source_key_count
  FROM {GOLD_TABLE}
  ORDER BY tenant_id, veeva_account_id
""").show(truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
