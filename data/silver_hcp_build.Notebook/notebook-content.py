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

# # Silver build: hcp
# Builds `silver.hcp` (one row per Veeva account that's a person) from
# bronze Veeva account__v tables across all enabled tenants.
# Pattern is identical to `silver_account_xref_build`:
#   - Read `config.tenant_source_field_map` filtered to silver_table='hcp'
#   - Group by (tenant, source_system, bronze_table)
#   - For each group, generate a per-tenant SELECT that:
#       1. filters bronze to HCPs only (source-specific discriminator)
#       2. dedupes by id (latest modified_date__v wins) — collapses the
#          incremental append history into current state
#       3. projects bronze columns into silver columns per the field map
#       4. NULLs unmapped silver columns
#   - UNION ALL across groups, write to silver.hcp (overwrite)
# Concerns split:
#   - Entity shape (silver columns, dedup key, source filters): hardcoded
#     in this notebook — different silver entities have different rules
#   - Field-level routing (bronze col -> silver col): from field map
# Source-specific assumptions hardcoded here:
#   veeva: HCP = ispersonaccount__v = 'true'; dedup by id, modified_date__v
# Other source systems (e.g. salesforce) would need their own discriminator
# and dedup keys added to SOURCE_RULES below when we ingest from them.


# CELL ********************

SILVER_TABLE = "silver.hcp"
ENTITY = "hcp"

# Silver columns populated from the field map (in projection order).
MAPPED_COLUMNS = [
    # Cross-system identifiers. veeva_account_id is always set from the
    # dedup key. NPI is universal for HCPs; Network ID is the canonical
    # cross-system pharma master-data spine; DEA only for prescribers.
    "npi", "network_id", "dea_number",
    "name", "first_name", "last_name", "middle_name",
    "prefix", "suffix", "credentials",
    "specialty_primary", "specialty_secondary",
    "gender",
    "email", "phone_office", "phone_mobile",
    "city", "state", "postal_code", "country",
    "is_prescriber", "is_kol", "is_speaker", "is_investigator",
    "status", "segmentation",
    "tier", "account_type", "source_id",
    # Primary HCO affiliation — Veeva's account.primary_parent__v points
    # an HCP at their parent HCO account (the "where do they practice"
    # link). Carried as raw account_id at silver; gold dim_hcp resolves
    # to a surrogate hco_key + name so explore matrices can group HCPs
    # by affiliation.
    "primary_parent_account_id",
]

# Silver columns that should be translated through silver.picklist.
# For each, the build LEFT JOINs silver.picklist on (tenant, object, field, code)
# and projects COALESCE(label, raw_code) so codes that fail to translate fall
# back to their raw values. Booleans, free-text, and IDs stay out.
PICKLIST_SILVER_COLUMNS: set[str] = {
    "specialty_primary", "specialty_secondary",
    "state", "country",
    "status", "tier", "account_type",
    "gender",
}

# Per-source-system rules. Each entry says how to identify HCPs in that
# source's bronze tables and which columns key the dedup. Add a new entry
# when ingesting a new source.
SOURCE_RULES: dict[str, dict[str, str]] = {
    "veeva": {
        "filter": "ispersonaccount__v = 'true'",
        "dedup_key_bronze": "id",
        "dedup_order_bronze": "modified_date__v",
        # Strip this prefix from the bronze table name to get the Veeva object
        # name used for picklist lookups (e.g. veeva_obj_account__v -> account__v).
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
  veeva_account_id     STRING    NOT NULL,
  source_system        STRING    NOT NULL,
  npi                  STRING,
  name                 STRING,
  first_name           STRING,
  last_name            STRING,
  middle_name          STRING,
  prefix               STRING,
  suffix               STRING,
  credentials          STRING,
  specialty_primary    STRING,
  specialty_secondary  STRING,
  gender               STRING,
  email                STRING,
  phone_office         STRING,
  phone_mobile         STRING,
  city                 STRING,
  state                STRING,
  postal_code          STRING,
  country              STRING,
  is_prescriber        STRING,
  is_kol               STRING,
  is_speaker           STRING,
  is_investigator      STRING,
  status               STRING,
  segmentation         STRING,
  tier                 STRING,
  account_type         STRING,
  source_id            STRING,
  primary_parent_account_id STRING,
  silver_built_at      TIMESTAMP NOT NULL
) USING DELTA
""")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Read the field map for hcp + tenant slugs
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
        f"No field-map rows found for silver_table='{ENTITY}'. "
        "Run seed-veeva-hcp-field-map.sql + config_sync."
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
            f"No SOURCE_RULES entry for source_system='{source_system}'. "
            f"Add filter + dedup keys to SOURCE_RULES."
        )
    rules = SOURCE_RULES[source_system]
    filter_clause = rules["filter"]
    dedup_key = rules["dedup_key_bronze"]
    dedup_order = rules["dedup_order_bronze"]
    prefix_strip = rules.get("bronze_table_prefix_strip", "")

    bronze_schema = f"bronze_{slug_to_schema(tenant_slug)}"
    bronze_ref = f"{bronze_schema}.{bronze_table}"

    # Introspect bronze schema once. Field-map entries whose bronze column
    # isn't actually present in this tenant's source get downgraded to a
    # NULL projection with a warning — keeps the build resilient when a
    # tenant has a Veeva customization missing or when we add new optional
    # identifier fields (network_id, dea_number, etc.) before every
    # tenant has them populated.
    bronze_columns = {f.name.lower() for f in spark.table(bronze_ref).schema.fields}

    # Veeva object name used for picklist lookups
    veeva_object = (
        bronze_table[len(prefix_strip):] if prefix_strip and bronze_table.startswith(prefix_strip)
        else bronze_table
    )

    # Project: literals + (bronze_id) + each silver column.
    # For picklist columns: COALESCE(picklist_alias.label, raw_bronze_value).
    # For non-picklist mapped columns: pass through raw bronze value.
    # For unmapped columns OR mapped-but-missing-in-bronze: NULL.
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
            # Either no field-map entry, or the field-map points to a
            # bronze column that doesn't exist in this tenant. Project NULL
            # and warn loudly so the operator notices in the run log.
            if silver_col in col_map:
                print(
                    f"  ⚠ {bronze_ref}: silver.{silver_col} mapped to "
                    f"`{col_map[silver_col]}` which is missing from bronze — "
                    f"projecting NULL."
                )
            projections.append(f"  CAST(NULL AS STRING) AS {silver_col}")
    projections.append(f"  current_timestamp() AS silver_built_at")

    join_block = "\n".join(picklist_joins)

    select = f"""
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
    return select


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

# Show generated SQL — useful for debugging mapping issues
print("=== Generated silver.hcp build SQL ===\n")
print(union_sql)
print("\n=== End ===\n")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Execute: overwrite silver.hcp with the unioned, deduped result
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
  SELECT tenant_id, source_system, COUNT(*) AS hcps
  FROM {SILVER_TABLE}
  GROUP BY tenant_id, source_system
  ORDER BY tenant_id, source_system
""").show(truncate=False)

print("=== Status mix ===")
spark.sql(f"""
  SELECT status, COUNT(*) AS n
  FROM {SILVER_TABLE}
  GROUP BY status
  ORDER BY n DESC
""").show(20, truncate=False)

print("=== Specialty top 20 ===")
spark.sql(f"""
  SELECT specialty_primary, COUNT(*) AS n
  FROM {SILVER_TABLE}
  GROUP BY specialty_primary
  ORDER BY n DESC
""").show(20, truncate=False)

print("=== Sample 5 rows ===")
spark.sql(f"""
  SELECT veeva_account_id, npi, name, specialty_primary, state, tier, status
  FROM {SILVER_TABLE}
  LIMIT 5
""").show(truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
