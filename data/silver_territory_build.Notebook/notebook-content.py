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

# # Silver build: territory
#
# Tiny table (~50 rows in fennec) but foundational. Sales territories that
# users are assigned to and that calls/HCPs roll up into. Hierarchy via
# `parent_territory_id`.

# CELL ********************

SILVER_TABLE = "silver.territory"
ENTITY = "territory"

MAPPED_COLUMNS = [
    "name", "api_name", "description",
    "parent_territory_id", "owner_user_id",
    "country", "status",
]

PICKLIST_SILVER_COLUMNS: set[str] = {"country", "status"}

SOURCE_RULES: dict[str, dict[str, str]] = {
    "veeva": {
        "filter": "1 = 1",
        "dedup_key_bronze": "id",
        "dedup_order_bronze": "modified_date__v",
        "bronze_table_prefix_strip": "veeva_obj_",
    },
}

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark",
# META   "tags": ["parameters"]
# META }

# CELL ********************

spark.sql("CREATE SCHEMA IF NOT EXISTS silver")
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {SILVER_TABLE} (
  tenant_id            STRING    NOT NULL,
  id                   STRING    NOT NULL,
  veeva_territory_id   STRING    NOT NULL,
  source_system        STRING    NOT NULL,
  name                 STRING,
  api_name             STRING,
  description          STRING,
  parent_territory_id  STRING,
  owner_user_id        STRING,
  country              STRING,
  status               STRING,
  team_role            STRING,
  silver_built_at      TIMESTAMP NOT NULL
) USING DELTA
""")

# Tenant-specific rules for deriving team role from territory description.
# Fennec encodes team in description text: '...SAM...' = Sales Account Manager,
# '...KAD...' = Key Account Director, else = ALL (catch-all for MSL/general).
# Other tenants will have their own conventions; this dict is the seam for
# adding their rules. Long-term: move to a config table per tenant.
TEAM_ROLE_RULES: dict[str, list[tuple[str, str]]] = {
    "veeva": [
        ("%SAM%", "SAM"),
        ("%KAD%", "KAD"),
    ],
}
TEAM_ROLE_DEFAULT = "ALL"

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

field_map_rows = spark.sql(f"""
  SELECT fm.tenant_id, t.slug AS tenant_slug, fm.source_system,
         fm.silver_column, fm.bronze_source_table, fm.bronze_source_column
  FROM config.tenant_source_field_map fm
  JOIN config.tenant t ON t.id = fm.tenant_id
  WHERE fm.silver_table = '{ENTITY}'
    AND t.status = 'active'
    AND fm.bronze_source_column IS NOT NULL
""").collect()

from collections import defaultdict
groups: dict[tuple, dict[str, str]] = defaultdict(dict)
for r in field_map_rows:
    key = (r.tenant_id, r.tenant_slug, r.source_system, r.bronze_source_table)
    groups[key][r.silver_column] = r.bronze_source_column

print(f"Field-map groups for silver.{ENTITY}: {len(groups)}")
for (tid, slug, src, bt), cols in groups.items():
    print(f"  [{slug}] {src} -> {bt}: {len(cols)} columns mapped")

if not groups:
    raise RuntimeError(
        f"No field-map rows for silver_table='{ENTITY}'. "
        "Run seed-veeva-territory-field-map.sql + config_sync."
    )

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

def slug_to_schema(slug: str) -> str:
    return slug.replace("-", "_")


def build_group_select(
    tenant_id: str,
    tenant_slug: str,
    source_system: str,
    bronze_table: str,
    col_map: dict[str, str],
) -> str:
    if source_system not in SOURCE_RULES:
        raise RuntimeError(f"No SOURCE_RULES for source_system='{source_system}'.")
    rules = SOURCE_RULES[source_system]
    filter_clause = rules["filter"]
    dedup_key = rules["dedup_key_bronze"]
    dedup_order = rules["dedup_order_bronze"]
    prefix_strip = rules.get("bronze_table_prefix_strip", "")

    bronze_schema = f"bronze_{slug_to_schema(tenant_slug)}"
    bronze_ref = f"{bronze_schema}.{bronze_table}"
    veeva_object = (
        bronze_table[len(prefix_strip):]
        if prefix_strip and bronze_table.startswith(prefix_strip)
        else bronze_table
    )

    projections = [
        f"  '{tenant_id}' AS tenant_id",
        f"  uuid() AS id",
        f"  ranked.id AS veeva_territory_id",
        f"  '{source_system}' AS source_system",
    ]
    picklist_joins: list[str] = []
    for silver_col in MAPPED_COLUMNS:
        if silver_col in col_map:
            bronze_col = col_map[silver_col]
            if silver_col in PICKLIST_SILVER_COLUMNS:
                alias = f"pl_{silver_col}"
                picklist_joins.append(
                    f"LEFT JOIN silver.picklist {alias}\n"
                    f"  ON {alias}.tenant_id = '{tenant_id}'\n"
                    f"  AND {alias}.object    = '{veeva_object}'\n"
                    f"  AND {alias}.field     = '{bronze_col}'\n"
                    f"  AND {alias}.code      = ranked.`{bronze_col}`"
                )
                projections.append(
                    f"  COALESCE({alias}.label, ranked.`{bronze_col}`) AS {silver_col}"
                )
            else:
                projections.append(f"  ranked.`{bronze_col}` AS {silver_col}")
        else:
            projections.append(f"  CAST(NULL AS STRING) AS {silver_col}")

    # Derive team_role from description per per-source rules.
    # If no description column is mapped, default to TEAM_ROLE_DEFAULT.
    description_bronze_col = col_map.get("description")
    rules = TEAM_ROLE_RULES.get(source_system, [])
    if description_bronze_col and rules:
        when_clauses = "\n           ".join(
            f"WHEN UPPER(ranked.`{description_bronze_col}`) LIKE '{pattern}' THEN '{role}'"
            for pattern, role in rules
        )
        projections.append(
            f"  CASE\n           {when_clauses}\n           "
            f"ELSE '{TEAM_ROLE_DEFAULT}'\n         END AS team_role"
        )
    else:
        projections.append(f"  '{TEAM_ROLE_DEFAULT}' AS team_role")

    projections.append(f"  current_timestamp() AS silver_built_at")

    join_block = "\n".join(picklist_joins)
    return f"""
WITH ranked AS (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY {dedup_key}
      ORDER BY {dedup_order} DESC NULLS LAST, _ingested_at DESC
    ) AS _rn
  FROM {bronze_ref}
  WHERE {filter_clause}
)
SELECT
{','.join(chr(10) + p for p in projections)}
FROM ranked
{join_block}
WHERE _rn = 1
"""


per_group_sql = [
    build_group_select(tid, slug, src, bt, cols)
    for (tid, slug, src, bt), cols in groups.items()
]
union_sql = "\nUNION ALL\n".join(f"({s})" for s in per_group_sql)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

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

print("=== Team role distribution ===")
spark.sql(f"""
  SELECT team_role, COUNT(*) AS n
  FROM {SILVER_TABLE}
  GROUP BY team_role
  ORDER BY n DESC
""").show(truncate=False)

print("=== Sample territories ===")
spark.sql(f"""
  SELECT veeva_territory_id, name, description, team_role, country, status
  FROM {SILVER_TABLE}
  ORDER BY name
  LIMIT 20
""").show(truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
