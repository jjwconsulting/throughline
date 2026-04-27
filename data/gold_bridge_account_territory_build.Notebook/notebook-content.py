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

# # Gold build: bridge_account_territory
#
# Bridges Veeva account (HCP or HCO) → territory, with one row per
# (tenant, account, territory) and an `is_primary` flag identifying the
# canonical territory assignment for sales attribution.
#
# Phase A v1 simplification: each account has exactly one is_primary=true
# territory. Co-coverage and per-product splitting are out of scope (per
# user 2026-04-26: "clients I've worked with have generally tried to keep
# one HCO per rep"). All non-primary rows are preserved as is_primary=false
# in case future surfaces want them.
#
# Primary-pick ranking (per tenant, per account):
#   1. Has eligible Sales rep on the territory > no-rep. A no-rep
#      territory can't actually credit anyone, so it should never beat
#      a sister territory with a real rep regardless of team_role. (Bug
#      caught 2026-04-27 with fennec — KAD-no-rep was winning over an
#      ALL-with-rep sister, sending the HCO's sales to "Unattributed".)
#   2. dim_territory.team_role: SAM (Sales Account Manager) > KAD (Key
#      Account Director) > ALL (catch-all, often MSL/general).
#   3. is_manual = 'true' over rule-assigned (manual assignments are
#      typically primary coverage; rule-based often secondary).
#   4. dim_territory.name alphabetical (deterministic tiebreaker).
#
# Schema notes:
#   - account_key matches dim_hcp.hcp_key OR dim_hco.hco_key
#     (md5(tenant + veeva_account_id) — same formula).
#   - territory_key matches dim_territory.territory_key.
#   - source_system defaults to 'veeva' since silver.account_territory
#     currently only sources from Veeva. Add other sources here when
#     they land.
#
# Depends on: silver.account_territory + gold.dim_territory.

# CELL ********************

GOLD_TABLE = "gold.bridge_account_territory"

spark.sql("CREATE SCHEMA IF NOT EXISTS gold")
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {GOLD_TABLE} (
  bridge_key             STRING    NOT NULL,
  tenant_id              STRING    NOT NULL,
  account_key            STRING    NOT NULL,
  territory_key          STRING    NOT NULL,
  veeva_account_id       STRING    NOT NULL,
  veeva_territory_id     STRING    NOT NULL,
  is_primary             BOOLEAN   NOT NULL,
  is_manual              STRING,
  rule                   STRING,
  assignment_name        STRING,
  source_system          STRING    NOT NULL,
  status                 STRING,
  gold_built_at          TIMESTAMP NOT NULL
) USING DELTA
""")

# CELL ********************

build_sql = f"""
WITH active_assignments AS (
  -- All silver.account_territory rows with non-null FK pair. Treat
  -- empty / 'Active' / null status as active (some sources don't
  -- populate status at all).
  SELECT
    at.tenant_id,
    at.account_id                                                        AS veeva_account_id,
    at.territory_id                                                      AS veeva_territory_id,
    md5(concat_ws('|', at.tenant_id, at.account_id))                     AS account_key,
    md5(concat_ws('|', at.tenant_id, at.territory_id))                   AS territory_key,
    at.is_manual,
    at.rule,
    at.assignment_name,
    at.status
  FROM silver.account_territory at
  WHERE at.account_id IS NOT NULL
    AND at.territory_id IS NOT NULL
    AND COALESCE(at.status, '') IN ('', 'Active', 'active')
),
ranked AS (
  -- Primary-pick: for each (tenant, account_key), rank candidate
  -- territory assignments. rn=1 wins is_primary.
  SELECT
    aa.*,
    dt.team_role,
    dt.name AS territory_name,
    ROW_NUMBER() OVER (
      PARTITION BY aa.tenant_id, aa.account_key
      ORDER BY
        -- 1. Has eligible Sales rep beats no-rep. Without this, an
        --    HCO whose top-team-role territory has no rep loses
        --    attribution entirely even when a sister territory has a
        --    real rep (observed 2026-04-27 with fennec data).
        CASE WHEN dt.current_rep_user_key IS NULL THEN 1 ELSE 0 END,
        -- 2. Team role: SAM (Sales Account Manager) > KAD (Key Account
        --    Director) > ALL (catch-all) > MSL (medical, doesn't drive
        --    sales). MSL is last since their territories shouldn't be
        --    primary for sales attribution even when the rep filter
        --    happens to allow them.
        CASE dt.team_role
          WHEN 'SAM' THEN 0
          WHEN 'KAD' THEN 1
          WHEN 'ALL' THEN 2
          WHEN 'MSL' THEN 3
          ELSE 4
        END,
        -- 3. Manual assignments over rule-assigned (manual is usually
        --    primary coverage; rule is often default/secondary).
        CASE WHEN aa.is_manual = 'true' THEN 0 ELSE 1 END,
        -- 4. Alphabetical by territory name (deterministic tiebreaker).
        dt.name ASC NULLS LAST
    ) AS rn
  FROM active_assignments aa
  LEFT JOIN gold.dim_territory dt
    ON dt.tenant_id = aa.tenant_id
    AND dt.veeva_territory_id = aa.veeva_territory_id
)
SELECT
  md5(concat_ws('|', tenant_id, account_key, territory_key))             AS bridge_key,
  tenant_id,
  account_key,
  territory_key,
  veeva_account_id,
  veeva_territory_id,
  CASE WHEN rn = 1 THEN true ELSE false END                              AS is_primary,
  is_manual,
  rule,
  assignment_name,
  'veeva'                                                                AS source_system,
  status,
  current_timestamp()                                                    AS gold_built_at
FROM ranked
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

# CELL ********************

# Verification

print("=== Coverage shape ===")
spark.sql(f"""
  SELECT
    COUNT(*)                                                AS total_assignments,
    COUNT(DISTINCT account_key)                             AS distinct_accounts,
    COUNT(DISTINCT territory_key)                           AS distinct_territories,
    SUM(CASE WHEN is_primary THEN 1 ELSE 0 END)             AS primary_count,
    ROUND(1.0 * COUNT(*) / COUNT(DISTINCT account_key), 2)  AS avg_assignments_per_account
  FROM {GOLD_TABLE}
""").show(truncate=False)

print("=== Distribution: assignments per account ===")
spark.sql(f"""
  WITH per_account AS (
    SELECT account_key, COUNT(*) AS n_territories
    FROM {GOLD_TABLE}
    GROUP BY account_key
  )
  SELECT n_territories, COUNT(*) AS n_accounts
  FROM per_account
  GROUP BY n_territories
  ORDER BY n_territories
""").show(truncate=False)

print("=== Sample 10 primary assignments ===")
spark.sql(f"""
  SELECT b.veeva_account_id, b.veeva_territory_id,
         b.is_manual, b.assignment_name, b.status
  FROM {GOLD_TABLE} b
  WHERE b.is_primary = true
  LIMIT 10
""").show(truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
