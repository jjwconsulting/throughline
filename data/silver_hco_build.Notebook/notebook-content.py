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

# # Silver build: hco
#
# Builds `silver.hco` (one row per Veeva account that's an institution) from
# bronze Veeva account__v across all enabled tenants.
#
# Same pattern as silver_hcp_build, but with:
#   - HCO discriminator: `ispersonaccount__v = 'false'`
#   - HCO-relevant columns (beds, AHA ID, hospital_type, parent account, etc.)
#
# Depends on `silver.picklist` for label translation. Run
# silver_picklist_build first.

# CELL ********************

SILVER_TABLE = "silver.hco"
ENTITY = "hco"

MAPPED_COLUMNS = [
    "name",
    "hco_type", "hospital_type", "hco_class", "account_group",
    # Cross-system identifiers (alternates to veeva_account_id, which is
    # always set from the dedup key). Nullable; populated only when the
    # source Veeva tenant has the field. Network ID is the canonical
    # cross-system key in pharma master data — many transitioning clients
    # use it as their mapping-file join key instead of the CRM Account ID.
    "network_id", "npi", "dea_number",
    "aha_id", "bed_count",
    "email", "phone_office",
    "city", "state", "postal_code", "country",
    "parent_account_id",
    "status", "segmentation",
    "tier", "account_type",
    "focus_area_1", "major_class_of_trade",
    "tax_id", "source_id",
]

# Silver columns that translate through silver.picklist.
PICKLIST_SILVER_COLUMNS: set[str] = {
    "hco_type", "hospital_type", "hco_class", "account_group",
    "state", "country", "status",
    "tier", "account_type",
    "focus_area_1", "major_class_of_trade",
}

SOURCE_RULES: dict[str, dict[str, str]] = {
    "veeva": {
        "filter": "ispersonaccount__v = 'false'",
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
  tenant_id             STRING    NOT NULL,
  id                    STRING    NOT NULL,
  veeva_account_id      STRING    NOT NULL,
  source_system         STRING    NOT NULL,
  name                  STRING,
  hco_type              STRING,
  hospital_type         STRING,
  hco_class             STRING,
  account_group         STRING,
  aha_id                STRING,
  bed_count             STRING,
  email                 STRING,
  phone_office          STRING,
  city                  STRING,
  state                 STRING,
  postal_code           STRING,
  country               STRING,
  parent_account_id     STRING,
  status                STRING,
  segmentation          STRING,
  tier                  STRING,
  account_type          STRING,
  focus_area_1          STRING,
  major_class_of_trade  STRING,
  tax_id                STRING,
  source_id             STRING,
  silver_built_at       TIMESTAMP NOT NULL
) USING DELTA
""")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Read field map for hco + tenant slugs
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
        "Run seed-veeva-hco-field-map.sql + config_sync."
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
        raise RuntimeError(
            f"No SOURCE_RULES entry for source_system='{source_system}'."
        )
    rules = SOURCE_RULES[source_system]
    filter_clause = rules["filter"]
    dedup_key = rules["dedup_key_bronze"]
    dedup_order = rules["dedup_order_bronze"]
    prefix_strip = rules.get("bronze_table_prefix_strip", "")

    bronze_schema = f"bronze_{slug_to_schema(tenant_slug)}"
    bronze_ref = f"{bronze_schema}.{bronze_table}"

    # Introspect bronze schema once. Field-map entries pointing to a
    # bronze column that doesn't exist in this tenant's source get
    # downgraded to NULL projection with a warning — keeps the build
    # resilient when adding optional identifier fields (network_id,
    # dea_number) before every tenant has them.
    bronze_columns = {f.name.lower() for f in spark.table(bronze_ref).schema.fields}

    veeva_object = (
        bronze_table[len(prefix_strip):]
        if prefix_strip and bronze_table.startswith(prefix_strip)
        else bronze_table
    )

    projections = [
        f"  '{tenant_id}' AS tenant_id",
        f"  uuid() AS id",
        f"  ranked.id AS veeva_account_id",
        f"  '{source_system}' AS source_system",
    ]
    picklist_joins: list[str] = []
    for silver_col in MAPPED_COLUMNS:
        if silver_col in col_map and col_map[silver_col].lower() in bronze_columns:
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
            if silver_col in col_map:
                print(
                    f"  ⚠ {bronze_ref}: silver.{silver_col} mapped to "
                    f"`{col_map[silver_col]}` which is missing from bronze — "
                    f"projecting NULL."
                )
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

# Execute + write
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

# Verification
print("=== Per-tenant counts ===")
spark.sql(f"""
  SELECT tenant_id, source_system, COUNT(*) AS hcos
  FROM {SILVER_TABLE}
  GROUP BY tenant_id, source_system
  ORDER BY tenant_id
""").show(truncate=False)

print("=== Top HCO types ===")
spark.sql(f"""
  SELECT hco_type, COUNT(*) AS n
  FROM {SILVER_TABLE}
  WHERE hco_type IS NOT NULL
  GROUP BY hco_type
  ORDER BY n DESC
""").show(20, truncate=False)

print("=== Status mix ===")
spark.sql(f"""
  SELECT status, COUNT(*) AS n
  FROM {SILVER_TABLE}
  GROUP BY status
  ORDER BY n DESC
""").show(20, truncate=False)

print("=== Sample 5 rows ===")
spark.sql(f"""
  SELECT veeva_account_id, name, hco_type, state, bed_count, tier, status
  FROM {SILVER_TABLE}
  LIMIT 5
""").show(truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
