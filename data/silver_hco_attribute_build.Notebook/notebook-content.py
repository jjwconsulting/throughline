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

# # Silver build: hco_attribute
# Builds `silver.hco_attribute` (long format, one row per HCO × attribute)
# from per-tenant bronze tables, driven by `config.tenant_attribute_map`
# rows where `entity_type='hco'` AND `active=true`.
#
# Mirror of `silver_hcp_attribute_build` — see that notebook for the full
# narrative. Only the SOURCE_RULES discriminator differs (HCO instead of
# HCP). Spec: docs/architecture/tenant-custom-attributes.md.


# CELL ********************

SILVER_TABLE = "silver.hco_attribute"
ENTITY = "hco"

# Per-source-system rules. HCO identification mirrors silver_hco_build.
SOURCE_RULES: dict[str, dict[str, str]] = {
    "veeva": {
        "filter": "ispersonaccount__v = 'false'",
        "dedup_key_bronze": "id",
        "dedup_order_bronze": "modified_date__v",
        "id_column": "id",
    },
    "sftp": {
        "filter": "1 = 1",
        "dedup_key_bronze": "hco_id",
        "dedup_order_bronze": "_ingested_at",
        "id_column": "hco_id",
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
  tenant_id        STRING    NOT NULL,
  hco_id           STRING    NOT NULL,
  attribute_name   STRING    NOT NULL,
  attribute_value  STRING,
  attribute_type   STRING    NOT NULL,
  source_system    STRING    NOT NULL,
  source_label     STRING    NOT NULL,
  scope_tag        STRING,
  valid_as_of      DATE,
  silver_built_at  TIMESTAMP NOT NULL
) USING DELTA
""")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

attr_rows = spark.sql(f"""
  SELECT m.tenant_id, t.slug AS tenant_slug, m.source_system,
         m.bronze_table, m.bronze_column,
         m.attribute_name, m.attribute_type,
         m.source_label, m.scope_tag
  FROM config.tenant_attribute_map m
  JOIN config.tenant t ON t.id = m.tenant_id
  WHERE m.entity_type = '{ENTITY}'
    AND m.active = true
    AND t.status = 'active'
""").collect()

from collections import defaultdict
groups: dict[tuple, list] = defaultdict(list)
for r in attr_rows:
    key = (r.tenant_id, r.tenant_slug, r.source_system, r.bronze_table)
    groups[key].append({
        "bronze_column": r.bronze_column,
        "attribute_name": r.attribute_name,
        "attribute_type": r.attribute_type,
        "source_label": r.source_label,
        "scope_tag": r.scope_tag,
    })

print(f"Attribute config groups for silver.{ENTITY}_attribute: {len(groups)}")
for (tid, slug, src, bt), attrs in groups.items():
    print(f"  [{slug}] {src} -> {bt}: {len(attrs)} attribute(s)")

if not groups:
    print(
        f"⚠ No active attribute mappings found for entity_type='{ENTITY}'. "
        "Nothing to build. Configure mappings at /admin/attributes."
    )
    spark.sql(f"""
      CREATE OR REPLACE TABLE {SILVER_TABLE} AS
      SELECT
        CAST(NULL AS STRING)    AS tenant_id,
        CAST(NULL AS STRING)    AS hco_id,
        CAST(NULL AS STRING)    AS attribute_name,
        CAST(NULL AS STRING)    AS attribute_value,
        CAST(NULL AS STRING)    AS attribute_type,
        CAST(NULL AS STRING)    AS source_system,
        CAST(NULL AS STRING)    AS source_label,
        CAST(NULL AS STRING)    AS scope_tag,
        CAST(NULL AS DATE)      AS valid_as_of,
        CAST(NULL AS TIMESTAMP) AS silver_built_at
      WHERE 1 = 0
    """)
    mssparkutils.notebook.exit("no_config")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

def slug_to_schema(slug: str) -> str:
    return slug.replace("-", "_")


def sql_str(value) -> str:
    if value is None:
        return "CAST(NULL AS STRING)"
    return "'" + str(value).replace("'", "''") + "'"


def build_group_select(
    tenant_id: str,
    tenant_slug: str,
    source_system: str,
    bronze_table: str,
    attrs: list,
) -> str | None:
    if source_system not in SOURCE_RULES:
        raise RuntimeError(
            f"No SOURCE_RULES entry for source_system='{source_system}'. "
            f"Add filter + dedup keys to SOURCE_RULES."
        )
    rules = SOURCE_RULES[source_system]
    filter_clause = rules["filter"]
    dedup_key = rules["dedup_key_bronze"]
    dedup_order = rules["dedup_order_bronze"]
    id_column = rules["id_column"]

    bronze_schema = f"bronze_{slug_to_schema(tenant_slug)}"
    bronze_ref = f"{bronze_schema}.{bronze_table}"

    try:
        bronze_columns = {f.name.lower() for f in spark.table(bronze_ref).schema.fields}
    except Exception as exc:
        print(f"  ⚠ {bronze_ref}: cannot read bronze table — {exc}. Skipping group.")
        return None

    present_attrs = []
    for attr in attrs:
        if attr["bronze_column"].lower() in bronze_columns:
            present_attrs.append(attr)
        else:
            print(
                f"  ⚠ {bronze_ref}: bronze column `{attr['bronze_column']}` "
                f"declared for attribute `{attr['attribute_name']}` is missing — skipping."
            )

    if not present_attrs:
        print(f"  ⚠ {bronze_ref}: no declared attributes present in bronze. Skipping group.")
        return None

    stack_args = []
    for attr in present_attrs:
        bronze_col = attr["bronze_column"]
        stack_args.append(
            ", ".join([
                sql_str(attr["attribute_name"]),
                f"CAST(deduped.`{bronze_col}` AS STRING)",
                sql_str(attr["attribute_type"]),
                sql_str(attr["source_label"]),
                sql_str(attr["scope_tag"]),
            ])
        )
    # LATERAL VIEW column-list syntax is `AS col1, col2, ...` (NO parens).
    # Inline subqueries (not WITH) so each per-group SELECT can be wrapped
    # in (...) as a UNION ALL branch — Spark rejects top-level CTEs
    # inside parentheses.
    stack_call = (
        f"stack({len(present_attrs)},\n      "
        + ",\n      ".join(stack_args)
        + ")\n    AS attribute_name, attribute_value, attribute_type, source_label, scope_tag"
    )

    select = f"""
SELECT
  '{tenant_id}' AS tenant_id,
  CAST(deduped.`{id_column}` AS STRING) AS hco_id,
  attribute_name,
  attribute_value,
  attribute_type,
  '{source_system}' AS source_system,
  source_label,
  scope_tag,
  CAST(NULL AS DATE) AS valid_as_of,
  current_timestamp() AS silver_built_at
FROM (
  SELECT * FROM (
    SELECT *,
      ROW_NUMBER() OVER (
        PARTITION BY {dedup_key}
        ORDER BY {dedup_order} DESC NULLS LAST, _ingested_at DESC
      ) AS _rn
    FROM {bronze_ref}
    WHERE {filter_clause}
  ) ranked
  WHERE _rn = 1
) deduped
LATERAL VIEW {stack_call}
WHERE attribute_value IS NOT NULL
  AND TRIM(attribute_value) <> ''
"""
    return select


per_group_sql = []
for (tid, slug, src, bt), attrs in groups.items():
    sql = build_group_select(tid, slug, src, bt, attrs)
    if sql:
        per_group_sql.append(sql)

if not per_group_sql:
    print("⚠ All groups skipped (missing bronze tables/columns). Writing empty silver.hco_attribute.")
    spark.sql(f"""
      CREATE OR REPLACE TABLE {SILVER_TABLE} AS
      SELECT
        CAST(NULL AS STRING)    AS tenant_id,
        CAST(NULL AS STRING)    AS hco_id,
        CAST(NULL AS STRING)    AS attribute_name,
        CAST(NULL AS STRING)    AS attribute_value,
        CAST(NULL AS STRING)    AS attribute_type,
        CAST(NULL AS STRING)    AS source_system,
        CAST(NULL AS STRING)    AS source_label,
        CAST(NULL AS STRING)    AS scope_tag,
        CAST(NULL AS DATE)      AS valid_as_of,
        CAST(NULL AS TIMESTAMP) AS silver_built_at
      WHERE 1 = 0
    """)
    mssparkutils.notebook.exit("no_present_columns")

union_sql = "\nUNION ALL\n".join(f"({s})" for s in per_group_sql)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

print("=== Generated silver.hco_attribute build SQL ===\n")
preview = union_sql if len(union_sql) < 4000 else union_sql[:4000] + "\n... [truncated]"
print(preview)
print("\n=== End ===\n")

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
  SELECT tenant_id, source_system, COUNT(*) AS rows,
         COUNT(DISTINCT hco_id) AS distinct_hcos,
         COUNT(DISTINCT attribute_name) AS distinct_attributes
  FROM {SILVER_TABLE}
  GROUP BY tenant_id, source_system
  ORDER BY tenant_id, source_system
""").show(truncate=False)

print("=== Attribute coverage (rows per attribute_name) ===")
spark.sql(f"""
  SELECT attribute_name, attribute_type, source_label, scope_tag,
         COUNT(*) AS rows
  FROM {SILVER_TABLE}
  GROUP BY attribute_name, attribute_type, source_label, scope_tag
  ORDER BY rows DESC
""").show(50, truncate=False)

print("=== Sample 10 rows ===")
spark.sql(f"""
  SELECT tenant_id, hco_id, attribute_name, attribute_value, attribute_type, source_label
  FROM {SILVER_TABLE}
  LIMIT 10
""").show(truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
