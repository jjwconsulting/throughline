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

# # Silver build: user_territory bridge (current state)
# Many-to-many bridge: which users (sales reps) are assigned to which
# territories. Source: `bronze_<slug>.veeva_obj_user_territory__v`.
# Current-state only — captures the latest active assignments. For
# point-in-time accuracy ("which territory was rep X on when call Y
# happened?"), we'll add `silver.user_territory_assignment_scd2` later.
# For v1, fact_call attribution uses the current bridge.
# Same shape as silver.account_territory but for users instead of accounts.

# CELL ********************

SILVER_TABLE = "silver.user_territory"

spark.sql("CREATE SCHEMA IF NOT EXISTS silver")
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {SILVER_TABLE} (
  tenant_id            STRING    NOT NULL,
  id                   STRING    NOT NULL,
  veeva_assignment_id  STRING    NOT NULL,
  user_id              STRING    NOT NULL,
  territory_id         STRING    NOT NULL,
  status               STRING,
  silver_built_at      TIMESTAMP NOT NULL
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


def build_tenant_select(tenant_id: str, slug: str) -> str:
    schema = f"bronze_{slug_to_schema(slug)}"
    bronze_ref = f"{schema}.veeva_obj_user_territory__v"
    return f"""
WITH ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY id
      ORDER BY modified_date__v DESC NULLS LAST, _ingested_at DESC
    ) AS _rn
  FROM {bronze_ref}
)
SELECT
  '{tenant_id}'                                         AS tenant_id,
  uuid()                                                AS id,
  ranked.id                                             AS veeva_assignment_id,
  ranked.user__v                                        AS user_id,
  ranked.territory__v                                   AS territory_id,
  COALESCE(pl_status.label, ranked.status__v)           AS status,
  current_timestamp()                                   AS silver_built_at
FROM ranked
LEFT JOIN silver.picklist pl_status
  ON pl_status.tenant_id = '{tenant_id}'
  AND pl_status.object   = 'user_territory__v'
  AND pl_status.field    = 'status__v'
  AND pl_status.code     = ranked.status__v
WHERE ranked._rn = 1
"""

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

tenants = [
    r.asDict() for r in spark.sql("""
      SELECT t.id, t.slug
      FROM config.tenant t
      JOIN config.tenant_veeva tv ON tv.tenant_id = t.id
      WHERE t.status = 'active' AND tv.enabled = true
    """).collect()
]
print(f"Tenants to process: {[t['slug'] for t in tenants] or '(none)'}")

if not tenants:
    raise RuntimeError("No active Veeva tenants.")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

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

print("=== Per-tenant counts ===")
spark.sql(f"""
  SELECT tenant_id, COUNT(*) AS assignments,
         COUNT(DISTINCT user_id) AS distinct_users,
         COUNT(DISTINCT territory_id) AS distinct_territories
  FROM {SILVER_TABLE}
  GROUP BY tenant_id
""").show(truncate=False)

print("=== Status mix ===")
spark.sql(f"""
  SELECT status, COUNT(*) AS n
  FROM {SILVER_TABLE}
  GROUP BY status
  ORDER BY n DESC
""").show(truncate=False)

print("=== Assignments per user ===")
spark.sql(f"""
  SELECT n_terr, COUNT(*) AS user_count
  FROM (
    SELECT user_id, COUNT(DISTINCT territory_id) AS n_terr
    FROM {SILVER_TABLE}
    WHERE status IN ('Active', 'active__v')
    GROUP BY user_id
  )
  GROUP BY n_terr
  ORDER BY n_terr
""").show(truncate=False)

print("=== Sample (current active assignments with names) ===")
spark.sql(f"""
  SELECT u.name AS rep, t.name AS territory, t.team_role, ut.status
  FROM {SILVER_TABLE} ut
  LEFT JOIN silver.user u ON u.veeva_user_id = ut.user_id
  LEFT JOIN silver.territory t ON t.veeva_territory_id = ut.territory_id
  WHERE ut.status IN ('Active', 'active__v')
  ORDER BY u.name, t.name
  LIMIT 30
""").show(truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
