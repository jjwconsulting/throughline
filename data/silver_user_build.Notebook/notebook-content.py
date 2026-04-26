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

# # Silver build: user
# Builds `silver.user` from bronze Veeva `user__sys`. All users (active +
# inactive) included — historical calls reference inactive reps.
# Same pattern as silver_hcp_build / silver_hco_build but with no HCP/HCO
# discriminator (every row in user__sys is a user). Picklist translation
# applies to the categorical fields (user_type, status, country, etc.).

# CELL ********************

SILVER_TABLE = "silver.user"
ENTITY = "user"

MAPPED_COLUMNS = [
    "name", "first_name", "last_name",
    "email", "username", "federated_id", "employee_number",
    "title", "department", "division",
    "profile", "security_profile", "user_type",
    "manager_id", "primary_territory_id",
    "phone_office", "phone_mobile",
    "street", "city", "state", "postal_code", "country",
    "locale", "timezone", "language",
    "status", "is_active",
    "activation_date", "inactivation_date", "last_login",
]

# Subset of MAPPED_COLUMNS that translate through silver.picklist.
# IDs (manager, primary_territory) and free-text fields stay raw.
PICKLIST_SILVER_COLUMNS: set[str] = {
    "user_type", "status", "country",
    "locale", "timezone", "language",
    "department", "division",
}

SOURCE_RULES: dict[str, dict[str, str]] = {
    "veeva": {
        # No HCP/HCO-style discriminator — every row is a user.
        "filter": "1 = 1",
        "dedup_key_bronze": "id",
        "dedup_order_bronze": "modified_date__v",
        "bronze_table_prefix_strip": "veeva_obj_",
    },
}

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

spark.sql("CREATE SCHEMA IF NOT EXISTS silver")
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {SILVER_TABLE} (
  tenant_id            STRING    NOT NULL,
  id                   STRING    NOT NULL,
  veeva_user_id        STRING    NOT NULL,
  source_system        STRING    NOT NULL,
  name                 STRING,
  first_name           STRING,
  last_name            STRING,
  email                STRING,
  username             STRING,
  federated_id         STRING,
  employee_number      STRING,
  title                STRING,
  department           STRING,
  division             STRING,
  profile              STRING,
  security_profile     STRING,
  user_type            STRING,
  manager_id           STRING,
  primary_territory_id STRING,
  phone_office         STRING,
  phone_mobile         STRING,
  street               STRING,
  city                 STRING,
  state                STRING,
  postal_code          STRING,
  country              STRING,
  locale               STRING,
  timezone             STRING,
  language             STRING,
  status               STRING,
  is_active            STRING,
  activation_date      STRING,
  inactivation_date    STRING,
  last_login           STRING,
  silver_built_at      TIMESTAMP NOT NULL
) USING DELTA
""")

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
        "Run seed-veeva-user-field-map.sql + config_sync."
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
        f"  ranked.id AS veeva_user_id",
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

# Note: tenants vary in which field they use for active/inactive.
# Fennec uses `status` ('Active'/'Inactive'); the `isactive__v` field is
# universally 'false' regardless of reality. Other tenants may use isactive__v.
# Reporting against silver.user should prefer `status` as the lifecycle field.
print("=== Per-tenant counts ===")
spark.sql(f"""
  SELECT tenant_id, COUNT(*) AS users,
         SUM(CASE WHEN LOWER(status) = 'active' THEN 1 ELSE 0 END) AS active,
         SUM(CASE WHEN LOWER(status) = 'inactive' THEN 1 ELSE 0 END) AS inactive
  FROM {SILVER_TABLE}
  GROUP BY tenant_id
""").show(truncate=False)

print("=== User type mix ===")
spark.sql(f"""
  SELECT user_type, COUNT(*) AS n
  FROM {SILVER_TABLE}
  GROUP BY user_type
  ORDER BY n DESC
""").show(20, truncate=False)

print("=== Sample 5 rows ===")
spark.sql(f"""
  SELECT veeva_user_id, name, email, title, user_type, is_active
  FROM {SILVER_TABLE}
  LIMIT 5
""").show(truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
