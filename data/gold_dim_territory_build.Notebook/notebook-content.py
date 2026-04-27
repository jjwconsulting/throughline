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

# # Gold build: dim_territory
#
# Star-schema territory dimension built from `silver.territory` plus a
# resolution to the territory's current owning rep via `silver.user_territory`
# bridge + `gold.dim_user`.
#
#   - **`territory_key`** — md5 surrogate (tenant + veeva_territory_id).
#     Stable across rebuilds; used as FK from `gold.fact_sale.territory_key`
#     and (eventually) `gold.bridge_account_territory.territory_key`.
#   - **`current_rep_user_key`** — single-rep attribution (Phase A v1
#     simplification). Resolved from `silver.user_territory` via:
#       1. Filter to active assignments where the user is in
#          ELIGIBLE_REP_TYPES (default ['Sales']). Admin users get
#          assigned to many territories for visibility; medical / MSL
#          users don't drive sales attribution.
#       2. Among eligible candidates per territory, deterministic
#          tiebreak: alphabetical by name.
#       3. NULL when no eligible user is assigned — fact_sale rows in
#          this territory land in the "Territory unassigned" bucket and
#          surface on /admin/pipelines as a data-quality signal that
#          someone needs to assign a Sales rep in Veeva.
#
#     NOTE 1: silver.territory.owner_user_id was tried as a fallback in
#     an earlier iteration but proved actively misleading — Veeva's
#     `territory__v.owner__v` is typically the ADMIN who created the
#     territory record (e.g., a Veeva integration user), not the rep
#     covering the territory's accounts. Using it sent ~all attribution to
#     the same admin user. Bridge-only is correct.
#
#     NOTE 2: ELIGIBLE_REP_TYPES is the seam for tenant variations. If a
#     tenant uses a value other than 'Sales' for their sales reps (e.g.,
#     'Sales Rep', 'KAM', 'Account Executive'), add to the list.
#
# Per project memory `project_pipeline_architecture.md`: this notebook is a
# child of the global `incremental_refresh_pipeline` orchestrator. Add to
# its STEPS list after `silver_user_territory_build`.

# CELL ********************

GOLD_TABLE = "gold.dim_territory"

# Which silver.user.user_type values are eligible to be picked as the
# territory's primary sales rep. Sales-only by default; admin/medical
# get filtered out so they never receive sales attribution. Add tenant-
# specific values here when needed (e.g. 'KAM', 'Account Executive').
ELIGIBLE_REP_TYPES = ["Sales"]

spark.sql("CREATE SCHEMA IF NOT EXISTS gold")
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {GOLD_TABLE} (
  territory_key            STRING    NOT NULL,
  tenant_id                STRING    NOT NULL,
  veeva_territory_id       STRING    NOT NULL,
  source_system            STRING    NOT NULL,
  name                     STRING,
  api_name                 STRING,
  description              STRING,
  parent_territory_id      STRING,
  parent_territory_key     STRING,
  team_role                STRING,
  country                  STRING,
  status                   STRING,
  -- Single-rep attribution (Phase A v1, current-state). NULL when
  -- no rep is assigned. Switch to point-in-time SCD2 attribution when
  -- silver.user_territory_assignment_scd2 lands.
  current_rep_user_key     STRING,
  current_rep_veeva_user_id STRING,
  current_rep_name         STRING,
  current_rep_source       STRING,
  gold_built_at            TIMESTAMP NOT NULL
) USING DELTA
""")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Single-pass resolution for current_rep_user_key from the
# user_territory bridge, filtered to ELIGIBLE_REP_TYPES (Sales only by
# default). silver.territory.owner_user_id is intentionally NOT consulted
# (see docstring — it points to admin users, not reps).
#
# Per (tenant, territory), pick the eligible user with deterministic
# tiebreak: alphabetical by name. If no eligible user assigned, the
# territory's current_rep_user_key is NULL — fact_sale rows in this
# territory get attribution_status='no_rep' and roll up under
# "Unattributed" on the dashboard. That's the correct signal: an Admin
# or MSL shouldn't receive sales attribution.

eligible_types_sql = ", ".join(f"'{t}'" for t in ELIGIBLE_REP_TYPES)

build_sql = f"""
WITH bridge_candidates AS (
  SELECT
    ut.tenant_id,
    ut.territory_id                                   AS veeva_territory_id,
    md5(concat_ws('|', ut.tenant_id, u.veeva_user_id)) AS rep_user_key,
    u.veeva_user_id                                   AS rep_veeva_user_id,
    u.name                                            AS rep_name,
    'territory_bridge'                                AS rep_source,
    ROW_NUMBER() OVER (
      PARTITION BY ut.tenant_id, ut.territory_id
      ORDER BY u.name ASC NULLS LAST
    ) AS rn
  FROM silver.user_territory ut
  JOIN silver.user u
    ON u.tenant_id = ut.tenant_id
    AND u.veeva_user_id = ut.user_id
  WHERE COALESCE(ut.status, '') IN ('', 'Active', 'active')
    AND u.user_type IN ({eligible_types_sql})
),
combined_rep AS (
  SELECT tenant_id, veeva_territory_id, rep_user_key, rep_veeva_user_id,
         rep_name, rep_source
  FROM bridge_candidates WHERE rn = 1
)
SELECT
  md5(concat_ws('|', t.tenant_id, t.veeva_territory_id))                 AS territory_key,
  t.tenant_id,
  t.veeva_territory_id,
  t.source_system,
  t.name,
  t.api_name,
  t.description,
  t.parent_territory_id,
  CASE
    WHEN t.parent_territory_id IS NOT NULL
      THEN md5(concat_ws('|', t.tenant_id, t.parent_territory_id))
    ELSE NULL
  END                                                                    AS parent_territory_key,
  t.team_role,
  t.country,
  t.status,
  cr.rep_user_key                                                        AS current_rep_user_key,
  cr.rep_veeva_user_id                                                   AS current_rep_veeva_user_id,
  cr.rep_name                                                            AS current_rep_name,
  cr.rep_source                                                          AS current_rep_source,
  current_timestamp()                                                    AS gold_built_at
FROM silver.territory t
LEFT JOIN combined_rep cr
  ON cr.tenant_id = t.tenant_id
  AND cr.veeva_territory_id = t.veeva_territory_id
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

# Verification

print("=== Rep attribution coverage ===")
spark.sql(f"""
  SELECT
    COUNT(*) AS total_territories,
    SUM(CASE WHEN current_rep_user_key IS NOT NULL THEN 1 ELSE 0 END) AS with_rep,
    SUM(CASE WHEN current_rep_user_key IS NULL THEN 1 ELSE 0 END)     AS without_rep,
    ROUND(100.0 * SUM(CASE WHEN current_rep_user_key IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_with_rep
  FROM {GOLD_TABLE}
""").show(truncate=False)

print("=== Resolution source breakdown ===")
spark.sql(f"""
  SELECT current_rep_source, COUNT(*) AS n
  FROM {GOLD_TABLE}
  GROUP BY current_rep_source
  ORDER BY n DESC
""").show(truncate=False)

print("=== Sample 10 territories ===")
spark.sql(f"""
  SELECT name, team_role, current_rep_name, current_rep_source, status
  FROM {GOLD_TABLE}
  ORDER BY name
  LIMIT 10
""").show(truncate=False)

print("=== Territories with NO eligible Sales rep (data-quality gap) ===")
spark.sql(f"""
  SELECT name, team_role, status
  FROM {GOLD_TABLE}
  WHERE current_rep_user_key IS NULL
  ORDER BY name
""").show(truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
