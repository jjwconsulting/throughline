# %% [markdown]
# # Silver build: account_xref
#
# Crosswalk table: (tenant_id, source_system, source_key) -> veeva_account_id
# plus descriptive attributes (name, address parts, channel, DEA).
#
# Demonstrates the field-map-driven silver build pattern from ARCHITECTURE.md §4:
# the notebook reads `config.tenant_source_field_map`, generates one SELECT per
# (tenant, source_system, bronze_table), UNION ALLs them, collapses duplicates,
# and overwrites `silver.account_xref`.
#
# Concerns split:
#   - Entity shape (which silver columns exist, dedupe key, aggregation rule):
#     hardcoded in this notebook. Different silver entities have different rules.
#   - Field-level routing (which bronze column feeds which silver column, per
#     tenant and source): comes entirely from `config.tenant_source_field_map`.
#     No tenant names, source table names, or column names appear in the
#     notebook body. Add a new tenant → no notebook edits.
#
# Assumptions:
#   - Attached to `throughline_lakehouse` as default lakehouse.
#   - `config.tenant_source_field_map` has rows with silver_table='account_xref'
#     for each tenant we expect data from (run 002_config_sync after seeding).
#   - The referenced bronze tables exist (run 001_sftp_ingest after dropping files).

# %%
SILVER_TABLE = "silver.account_xref"
ENTITY = "account_xref"

# The silver columns that get populated from the field map.
# Order here is the order of projection in generated SELECTs.
MAPPED_COLUMNS = [
    "source_key",
    "veeva_account_id",
    "channel",
    "dea",
    "name",
    "city",
    "state",
    "postal_code",
]

# The dedupe key: one row per (tenant_id, source_system, <this column>).
# Must be one of MAPPED_COLUMNS — it's the business identity of a row in this
# silver entity.
DEDUPE_KEY = "source_key"

# Attribute columns that may differ across bronze rows with the same dedupe
# key — we take first() of each to collapse.
ATTRIBUTE_COLUMNS = [c for c in MAPPED_COLUMNS if c != DEDUPE_KEY]

# %%
spark.sql("CREATE SCHEMA IF NOT EXISTS silver")
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {SILVER_TABLE} (
  tenant_id          STRING    NOT NULL,
  id                 STRING    NOT NULL,
  source_system      STRING    NOT NULL,
  source_key         STRING    NOT NULL,
  veeva_account_id   STRING,
  channel            STRING,
  dea                STRING,
  name               STRING,
  city               STRING,
  state              STRING,
  postal_code        STRING,
  silver_built_at    TIMESTAMP NOT NULL
) USING DELTA
""")

# %%
# Pull the field map for this silver entity + tenant slugs (needed for schema names)
field_map_rows = spark.sql(f"""
  SELECT fm.tenant_id, t.slug AS tenant_slug, fm.source_system,
         fm.silver_column, fm.bronze_source_table, fm.bronze_source_column
  FROM config.tenant_source_field_map fm
  JOIN config.tenant t ON t.id = fm.tenant_id
  WHERE fm.silver_table = '{ENTITY}'
    AND t.status = 'active'
    AND fm.bronze_source_column IS NOT NULL
""").collect()

# Group by (tenant_id, tenant_slug, source_system, bronze_source_table)
# Value is {silver_column -> bronze_source_column}
from collections import defaultdict
groups: dict[tuple, dict[str, str]] = defaultdict(dict)
for r in field_map_rows:
    key = (r.tenant_id, r.tenant_slug, r.source_system, r.bronze_source_table)
    groups[key][r.silver_column] = r.bronze_source_column

print(f"Field-map groups to build from: {len(groups)}")
for (tid, slug, src, bt), cols in groups.items():
    print(f"  [{slug}] {src} -> {bt}: {len(cols)} cols")

if not groups:
    raise RuntimeError(
        f"No field-map rows found for silver_table='{ENTITY}'. "
        "Seed config.tenant_source_field_map and re-run the config_sync notebook."
    )

# %%
# SQL generation. Each group produces:
#   SELECT <literals>, <projections>, first(...) for attrs GROUP BY dedupe_key
def slug_to_schema(slug: str) -> str:
    return slug.replace("-", "_")


def build_group_select(
    tenant_id: str,
    tenant_slug: str,
    source_system: str,
    bronze_table: str,
    col_map: dict[str, str],
) -> str:
    schema = f"bronze_{slug_to_schema(tenant_slug)}"
    bronze_ref = f"{schema}.{bronze_table}"

    if DEDUPE_KEY not in col_map:
        raise RuntimeError(
            f"[{tenant_slug}/{source_system}/{bronze_table}] field map is missing "
            f"the dedupe key '{DEDUPE_KEY}'. Add a mapping for it."
        )

    dedupe_bronze_col = col_map[DEDUPE_KEY]

    # Aggregated attribute projections — for columns not in the field map, NULL.
    attr_projections = []
    for silver_col in ATTRIBUTE_COLUMNS:
        if silver_col in col_map:
            bronze_col = col_map[silver_col]
            attr_projections.append(
                f"  first(`{bronze_col}`) AS {silver_col}"
            )
        else:
            attr_projections.append(f"  CAST(NULL AS STRING) AS {silver_col}")

    lines = [
        f"SELECT",
        f"  '{tenant_id}' AS tenant_id,",
        f"  uuid() AS id,",
        f"  '{source_system}' AS source_system,",
        f"  `{dedupe_bronze_col}` AS {DEDUPE_KEY},",
        ",\n".join(attr_projections) + ",",
        f"  current_timestamp() AS silver_built_at",
        f"FROM {bronze_ref}",
        f"GROUP BY `{dedupe_bronze_col}`",
    ]
    return "\n".join(lines)


per_group_sql = [
    build_group_select(tid, slug, src, bt, cols)
    for (tid, slug, src, bt), cols in groups.items()
]

union_sql = "\nUNION ALL\n".join(f"({s})" for s in per_group_sql)

# %%
# For visibility — print the generated SQL. Helpful when debugging field-map issues.
print("=== Generated silver build SQL ===\n")
print(union_sql)
print("\n=== End of SQL ===\n")

# %%
# Execute: overwrite silver.account_xref with the unioned result.
result_df = spark.sql(union_sql)
row_count = result_df.count()

(
    result_df.write
    .format("delta")
    .mode("overwrite")
    .saveAsTable(SILVER_TABLE)
)

print(f"Wrote {row_count} rows to {SILVER_TABLE}")

# %%
# Verification
print("\n=== Per-tenant row counts ===")
spark.sql(f"""
  SELECT tenant_id, source_system, COUNT(*) AS rows
  FROM {SILVER_TABLE}
  GROUP BY tenant_id, source_system
  ORDER BY tenant_id, source_system
""").show(truncate=False)

print("=== Sample rows ===")
spark.sql(f"SELECT * FROM {SILVER_TABLE} LIMIT 10").show(truncate=False)
