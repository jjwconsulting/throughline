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

# # Silver build: call
#
# Builds `silver.call` from bronze Veeva `call2__v`. One row per call event
# (already deduped by id, latest modified_date__v).
#
# Includes ALL statuses (planned, in_progress, submitted, signed) — silver
# is raw business entity per ARCHITECTURE.md §2. Reports filter by `status`
# / `call_status` as needed.
#
# Foreign keys (`account_id`, `owner_user_id`, `territory_id`, etc.) stored
# raw. Resolution to silver.hcp/hco/user/territory happens in gold dim/fact
# notebooks via JOIN.
#
# Depends on `silver.picklist` for label translation. Run silver_picklist_build
# first.

# CELL ********************

SILVER_TABLE = "silver.call"
ENTITY = "call"

MAPPED_COLUMNS = [
    # Identity
    "name", "subject",
    # Foreign keys
    "account_id", "child_account_id", "person_id",
    "owner_user_id", "user_id", "territory_id",
    "created_by_user_id", "parent_call_id",
    # When
    "call_date", "call_datetime", "duration",
    "signature_date", "signature_timestamp", "submit_timestamp",
    # Classification
    "call_type", "call_channel", "call_status", "status",
    "signature_status", "check_in_status",
    "is_sampled_call", "is_remote_meeting",
    # Where
    "city", "state", "postal_code", "location",
    # Notes
    "comments", "notes", "pre_call_notes", "next_call_notes",
    # Products
    "detailed_products",
    "product_priority_1", "product_priority_2", "product_priority_3",
    # Fennec custom
    "materials_used", "msl_materials_used",
]

# Picklist-translated columns. IDs, dates, notes, booleans, and free text
# stay raw.
PICKLIST_SILVER_COLUMNS: set[str] = {
    "call_type", "call_channel", "call_status", "status",
    "signature_status", "check_in_status",
    "state",  # may or may not translate — depends on how Veeva defines it
}

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
  tenant_id              STRING    NOT NULL,
  id                     STRING    NOT NULL,
  veeva_call_id          STRING    NOT NULL,
  source_system          STRING    NOT NULL,
  name                   STRING,
  subject                STRING,
  account_id             STRING,
  child_account_id       STRING,
  person_id              STRING,
  owner_user_id          STRING,
  user_id                STRING,
  territory_id           STRING,
  created_by_user_id     STRING,
  parent_call_id         STRING,
  call_date              STRING,
  call_datetime          STRING,
  duration               STRING,
  signature_date         STRING,
  signature_timestamp    STRING,
  submit_timestamp       STRING,
  call_type              STRING,
  call_channel           STRING,
  call_status            STRING,
  status                 STRING,
  signature_status       STRING,
  check_in_status        STRING,
  is_sampled_call        STRING,
  is_remote_meeting      STRING,
  city                   STRING,
  state                  STRING,
  postal_code            STRING,
  location               STRING,
  comments               STRING,
  notes                  STRING,
  pre_call_notes         STRING,
  next_call_notes        STRING,
  detailed_products      STRING,
  product_priority_1     STRING,
  product_priority_2     STRING,
  product_priority_3     STRING,
  materials_used         STRING,
  msl_materials_used     STRING,
  silver_built_at        TIMESTAMP NOT NULL
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
        "Run seed-veeva-call-field-map.sql + config_sync."
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
        f"  ranked.id AS veeva_call_id",
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

print("=== Per-tenant counts ===")
spark.sql(f"""
  SELECT tenant_id, COUNT(*) AS calls
  FROM {SILVER_TABLE}
  GROUP BY tenant_id
""").show(truncate=False)

print("=== Status distribution ===")
spark.sql(f"""
  SELECT status, call_status, COUNT(*) AS n
  FROM {SILVER_TABLE}
  GROUP BY status, call_status
  ORDER BY n DESC
""").show(20, truncate=False)

print("=== Call type x channel ===")
spark.sql(f"""
  SELECT call_type, call_channel, COUNT(*) AS n
  FROM {SILVER_TABLE}
  GROUP BY call_type, call_channel
  ORDER BY n DESC
""").show(20, truncate=False)

print("=== Calls per top 10 reps ===")
spark.sql(f"""
  SELECT u.name AS rep, COUNT(*) AS calls
  FROM {SILVER_TABLE} c
  LEFT JOIN silver.user u ON u.veeva_user_id = c.owner_user_id
  GROUP BY u.name
  ORDER BY calls DESC
""").show(10, truncate=False)

print("=== Sample 5 rows ===")
spark.sql(f"""
  SELECT veeva_call_id, call_date, call_type, call_channel, status, account_id, owner_user_id, territory_id
  FROM {SILVER_TABLE}
  LIMIT 5
""").show(truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
