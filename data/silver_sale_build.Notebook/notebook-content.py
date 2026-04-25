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

# # Silver build: sale
#
# Builds `silver.sale` from per-tenant bronze sales tables. One row per
# distributor sales transaction line, daily grain. No dedup (each row IS
# the transaction; idempotency is the source's responsibility).
#
# Field-map driven via `config.tenant_source_field_map` — same pattern as
# silver.call. The map handles WHICH bronze column goes where; the type
# casts (date parsing, dollar stripping, numeric coercion) are applied
# uniformly here based on the canonical silver column name. Source-format
# differences (Fennec IntegriChain "$35,963.82" vs TriSalus raw numbers)
# are absorbed by safe CAST expressions that handle both shapes.
#
# Account RESOLUTION (distributor_account_id → veeva account_key) does NOT
# happen here — silver keeps raw distributor IDs. Resolution happens in the
# gold build by LEFT JOINing silver.account_xref. Unmapped rows survive to
# gold with NULL account_key.

# CELL ********************

SILVER_TABLE = "silver.sale"
ENTITY = "sale"

# Canonical silver columns. Field map rows pick which bronze column maps
# to each (per source). Anything not mapped becomes NULL in silver.
MAPPED_COLUMNS = [
    # When
    "transaction_date", "transaction_type",
    # Account (raw, kept even after gold resolves)
    "distributor_account_id", "distributor_account_name",
    "account_address_line1", "account_city", "account_state", "account_postal_code",
    # Geographic / org context fallbacks (TriSalus has distributor_territory;
    # Fennec doesn't)
    "distributor_territory", "channel", "class_of_trade",
    # Product
    "product_ndc", "product_source_id", "product_name",
    "product_pack_description", "brand", "business_unit",
    # Numeric
    "units", "units_packs", "net_dollars", "gross_dollars",
    # Refs
    "invoice_number",
]

# Type-safe casts per silver column. Applied uniformly across sources, so
# a column that's "$35,963.82" in Fennec and "35963.82" in TriSalus both
# yield the same DOUBLE. Bronze stays STRING; silver is typed.
#
# {col} is the bronze column reference (already backtick-quoted).
#
# `to_date(col, fmt)` returns NULL on parse failure when ANSI mode is off
# (Fabric default), so COALESCE walks multiple format candidates safely.
# `try_to_date` would be nicer but isn't available in older Spark runtimes.
TYPE_CASTS: dict[str, str] = {
    # Try multiple date formats; first non-null wins. Add formats here as
    # new tenants land. M/d/yyyy is the Fennec/IntegriChain default; ISO
    # date cells (XLSX export, modern feeds) hit the second branch.
    "transaction_date":
        "COALESCE("
        "to_date({col}, 'M/d/yyyy'), "
        "to_date({col}, 'yyyy-MM-dd'), "
        "TRY_CAST({col} AS DATE)"
        ")",
    # Strip $ and , then CAST. NULL-safe (TRY_CAST returns NULL on bad input).
    "net_dollars":
        "TRY_CAST(REPLACE(REPLACE({col}, '$', ''), ',', '') AS DOUBLE)",
    "gross_dollars":
        "TRY_CAST(REPLACE(REPLACE({col}, '$', ''), ',', '') AS DOUBLE)",
    "units":
        "TRY_CAST(REPLACE({col}, ',', '') AS DOUBLE)",
    "units_packs":
        "TRY_CAST(REPLACE({col}, ',', '') AS DOUBLE)",
}

# Default transaction_type when source doesn't provide one explicitly.
# TriSalus uses "Invoice"; Fennec uses "SALES" / "RETURNS".
DEFAULT_TRANSACTION_TYPE = "SALES"

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
  tenant_id                  STRING    NOT NULL,
  id                         STRING    NOT NULL,
  source_system              STRING    NOT NULL,
  source_table               STRING    NOT NULL,
  transaction_date           DATE,
  transaction_type           STRING,
  distributor_account_id     STRING,
  distributor_account_name   STRING,
  account_address_line1      STRING,
  account_city               STRING,
  account_state              STRING,
  account_postal_code        STRING,
  distributor_territory      STRING,
  channel                    STRING,
  class_of_trade             STRING,
  product_ndc                STRING,
  product_source_id          STRING,
  product_name               STRING,
  product_pack_description   STRING,
  brand                      STRING,
  business_unit              STRING,
  units                      DOUBLE,
  units_packs                DOUBLE,
  net_dollars                DOUBLE,
  gross_dollars              DOUBLE,
  invoice_number             STRING,
  silver_built_at            TIMESTAMP NOT NULL
) USING DELTA
""")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Pull field map for sales. Same shape as silver_call_build — group by
# (tenant, source_system, bronze_table) and emit one SELECT per group,
# UNION ALL.
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
        "Run seed-fennec-sales-867-field-map.sql + config_sync first."
    )

# Per-feed cadence from config.tenant_sftp_feed. Keyed by (tenant_id,
# feed_name) where feed_name is the bronze_source_table with the leading
# "sftp_" stripped (e.g. "sftp_sales_867" -> "sales_867"). Defaults to
# 'incremental' if no row exists, matching legacy behavior.
feed_rows = spark.sql("""
  SELECT tenant_id, feed_name, feed_type
  FROM config.tenant_sftp_feed
  WHERE enabled = TRUE AND silver_table = 'sale'
""").collect()
feed_type_by_key: dict[tuple, str] = {
    (r.tenant_id, r.feed_name): r.feed_type for r in feed_rows
}
print(f"Sale feed configs: {len(feed_type_by_key)}")
for (tid, fn), ft in feed_type_by_key.items():
    print(f"  [{tid[:8]}…] {fn}: {ft}")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

def slug_to_schema(slug: str) -> str:
    return slug.replace("-", "_")


def project_column(silver_col: str, bronze_col: str) -> str:
    """Apply the silver-column-specific cast to a bronze column ref."""
    bronze_ref = f"src.`{bronze_col}`"
    cast_template = TYPE_CASTS.get(silver_col)
    if cast_template:
        return cast_template.format(col=bronze_ref) + f" AS {silver_col}"
    return f"{bronze_ref} AS {silver_col}"


def feed_name_from_bronze(bronze_table: str) -> str:
    """sftp_sales_867 -> sales_867; identity if no sftp_ prefix."""
    return (
        bronze_table[len("sftp_"):]
        if bronze_table.startswith("sftp_")
        else bronze_table
    )


def build_group_select(
    tenant_id: str,
    tenant_slug: str,
    source_system: str,
    bronze_table: str,
    col_map: dict[str, str],
) -> str:
    bronze_schema = f"bronze_{slug_to_schema(tenant_slug)}"
    bronze_ref = f"{bronze_schema}.{bronze_table}"

    # Snapshot vs incremental: snapshot feeds keep only rows from the latest
    # source_file (each new IC ITD file replaces the prior snapshot). Default
    # to incremental when no feed config row exists.
    feed_name = feed_name_from_bronze(bronze_table)
    feed_type = feed_type_by_key.get((tenant_id, feed_name), "incremental")

    if feed_type == "full_snapshot":
        # Pick latest _source_file per (tenant, bronze table) by ingest order.
        # The bronze table includes _ingested_at + _source_file from sftp_ingest.
        source_cte = f"""
WITH latest_file AS (
  SELECT MAX(_source_file) AS latest_source_file
  FROM (
    SELECT _source_file, MAX(_ingested_at) AS last_ingested
    FROM {bronze_ref}
    GROUP BY _source_file
    ORDER BY last_ingested DESC
    LIMIT 1
  ) f
),
src AS (
  SELECT b.* FROM {bronze_ref} b CROSS JOIN latest_file lf
  WHERE b._source_file = lf.latest_source_file
)
"""
    else:
        source_cte = f"""
WITH src AS (
  SELECT * FROM {bronze_ref}
)
"""

    projections = [
        f"  '{tenant_id}' AS tenant_id",
        # Synthetic per-row id. We don't have a reliable natural key across
        # all sources (IntegriChain has Invoice Number but it can repeat
        # across line items; TriSalus has no transaction id). uuid() is
        # cheap and deterministic enough — silver is rebuilt from bronze
        # idempotently, so re-runs are stable per session not eternally.
        # If a stable id matters later, switch to md5 of (tenant, table,
        # row hash).
        f"  uuid() AS id",
        f"  '{source_system}' AS source_system",
        f"  '{bronze_table}' AS source_table",
    ]
    for silver_col in MAPPED_COLUMNS:
        if silver_col in col_map:
            projections.append("  " + project_column(silver_col, col_map[silver_col]))
        elif silver_col == "transaction_type":
            # Default when source doesn't provide
            projections.append(
                f"  '{DEFAULT_TRANSACTION_TYPE}' AS transaction_type"
            )
        else:
            projections.append(f"  CAST(NULL AS STRING) AS {silver_col}")
    projections.append(f"  current_timestamp() AS silver_built_at")

    return f"""
{source_cte}
SELECT
{','.join(chr(10) + p for p in projections)}
FROM src
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

# Cast the columns where the field-map didn't pick them up (NULL ones) into
# their typed shapes. The select above projects them as STRING NULLs; we
# need the silver schema's typed columns.
from pyspark.sql import functions as F
result_df = (
    result_df
    .withColumn("transaction_date",
        F.col("transaction_date").cast("date"))
    .withColumn("units",         F.col("units").cast("double"))
    .withColumn("units_packs",   F.col("units_packs").cast("double"))
    .withColumn("net_dollars",   F.col("net_dollars").cast("double"))
    .withColumn("gross_dollars", F.col("gross_dollars").cast("double"))
)

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

print("=== Per-tenant + source counts ===")
spark.sql(f"""
  SELECT tenant_id, source_system, source_table, COUNT(*) AS rows,
         MIN(transaction_date) AS earliest_date,
         MAX(transaction_date) AS latest_date,
         ROUND(SUM(net_dollars), 0) AS total_net_dollars,
         ROUND(SUM(units), 0) AS total_units
  FROM {SILVER_TABLE}
  GROUP BY tenant_id, source_system, source_table
  ORDER BY tenant_id
""").show(truncate=False)

print("=== Transaction type distribution ===")
spark.sql(f"""
  SELECT transaction_type, COUNT(*) AS n
  FROM {SILVER_TABLE}
  GROUP BY transaction_type
  ORDER BY n DESC
""").show(truncate=False)

print("=== Top 10 distributor accounts by net_dollars ===")
spark.sql(f"""
  SELECT distributor_account_id, distributor_account_name,
         account_state,
         ROUND(SUM(net_dollars), 0) AS net_dollars,
         ROUND(SUM(units), 0) AS units
  FROM {SILVER_TABLE}
  GROUP BY distributor_account_id, distributor_account_name, account_state
  ORDER BY net_dollars DESC
""").show(10, truncate=False)

print("=== Sample 5 rows ===")
spark.sql(f"""
  SELECT transaction_date, distributor_account_name, product_name,
         units, net_dollars, transaction_type
  FROM {SILVER_TABLE}
  ORDER BY transaction_date DESC
  LIMIT 5
""").show(truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
