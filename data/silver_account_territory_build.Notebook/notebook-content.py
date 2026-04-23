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

# # Silver build: account_territory bridge
#
# Many-to-many bridge: which (HCP or HCO) accounts are assigned to which
# territories. Built from `bronze_<slug>.veeva_obj_account_territory__v`.
#
# Polymorphic on account type — one row per (account, territory) regardless
# of whether the account is an HCP or HCO. Downstream joins filter by joining
# to `silver.hcp` (for HCP coverage) or `silver.hco` (for HCO coverage).
#
# Fennec has multiple-territory assignments per HCP because of overlapping
# team coverage (Sales / MSL / KAM). Keeping all assignments preserves that.
# Other clients with 1 HCP : 1 territory get one row each — same shape, no
# special-casing.
#
# Fields preserved beyond just the FK pair:
#   - status (translated via picklist)
#   - is_manual: true if manually assigned, false if rule-assigned
#   - rule: name/id of the rule that auto-assigned (proxy for "team" or
#     "alignment type" when explicit team__v field is absent)
#
# Hardcoded build (no field-map) because the bridge schema is uniform
# across tenants — same as silver.picklist.
#
# Depends on silver.picklist (for status translation). Run silver_picklist_build
# first.

# CELL ********************

SILVER_TABLE = "silver.account_territory"

spark.sql("CREATE SCHEMA IF NOT EXISTS silver")
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {SILVER_TABLE} (
  tenant_id            STRING    NOT NULL,
  id                   STRING    NOT NULL,
  veeva_assignment_id  STRING    NOT NULL,
  account_id           STRING    NOT NULL,
  territory_id         STRING    NOT NULL,
  status               STRING,
  is_manual            STRING,
  rule                 STRING,
  assignment_name      STRING,
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


# Per-tenant SELECT: dedup bronze account_territory__v by latest modified_date,
# translate status via silver.picklist (object='account_territory__v',
# field='status__v').
def build_tenant_select(tenant_id: str, slug: str) -> str:
    schema = f"bronze_{slug_to_schema(slug)}"
    bronze_ref = f"{schema}.veeva_obj_account_territory__v"
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
  ranked.account__v                                     AS account_id,
  ranked.territory__v                                   AS territory_id,
  COALESCE(pl_status.label, ranked.status__v)           AS status,
  ranked.manual__v                                      AS is_manual,
  ranked.rule__v                                        AS rule,
  ranked.name__v                                        AS assignment_name,
  current_timestamp()                                   AS silver_built_at
FROM ranked
LEFT JOIN silver.picklist pl_status
  ON pl_status.tenant_id = '{tenant_id}'
  AND pl_status.object   = 'account_territory__v'
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

# Find tenants with Veeva data
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
         COUNT(DISTINCT account_id) AS distinct_accounts,
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

print("=== Manual vs rule-assigned ===")
spark.sql(f"""
  SELECT is_manual, COUNT(*) AS n
  FROM {SILVER_TABLE}
  GROUP BY is_manual
  ORDER BY n DESC
""").show(truncate=False)

print("=== Top assignment rules (proxy for team type) ===")
spark.sql(f"""
  SELECT rule, COUNT(*) AS n
  FROM {SILVER_TABLE}
  WHERE rule IS NOT NULL AND rule != ''
  GROUP BY rule
  ORDER BY n DESC
""").show(20, truncate=False)

# Test: typical fennec HCP — how many territories does an HCP have on average?
print("=== HCP coverage cardinality ===")
spark.sql(f"""
  WITH hcp_terr AS (
    SELECT at.account_id, COUNT(DISTINCT at.territory_id) AS n_territories
    FROM {SILVER_TABLE} at
    JOIN silver.hcp h ON h.veeva_account_id = at.account_id
                    AND h.tenant_id = at.tenant_id
    WHERE at.status IN ('Active', 'active__v')  -- handle pre/post translation
    GROUP BY at.account_id
  )
  SELECT
    n_territories,
    COUNT(*) AS hcp_count
  FROM hcp_terr
  GROUP BY n_territories
  ORDER BY n_territories
""").show(20, truncate=False)

print("=== Sample HCP with multiple territories ===")
spark.sql(f"""
  WITH multi AS (
    SELECT at.account_id
    FROM {SILVER_TABLE} at
    GROUP BY at.account_id
    HAVING COUNT(DISTINCT at.territory_id) >= 2
    LIMIT 1
  )
  SELECT h.name, at.territory_id, t.name AS territory_name, at.rule, at.status
  FROM {SILVER_TABLE} at
  JOIN multi ON at.account_id = multi.account_id
  LEFT JOIN silver.hcp h ON h.veeva_account_id = at.account_id
  LEFT JOIN silver.territory t ON t.veeva_territory_id = at.territory_id
  ORDER BY at.territory_id
""").show(20, truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
