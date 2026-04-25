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

# CELL ********************

# %% [markdown]
# # Bronze SFTP ingest
#
# Reads CSV files from `Files/sftp/<tenant_slug>/<feed_name>/*.csv` in the
# lakehouse and lands them into `bronze_<tenant_slug>.sftp_<feed_name>` with
# ingest metadata.
#
# Incremental-first (ARCHITECTURE.md §9.2): each file is ingested at most
# once; the `ops.sftp_ingest_log` table is the source of truth for what has
# already been processed.
#
# The SFTP protocol is not spoken by this notebook — an upstream SFTP host
# (VM with OpenSSH + BlobFuse, Azure Storage SFTP, etc.) is responsible for
# dropping files into the lakehouse's `Files/sftp/...` path. In dev, we
# upload test files manually via the lakehouse UI.
#
# Assumptions:
#   - Attached to `throughline_lakehouse` as default lakehouse.
#   - `config.*` schema + tables exist (001_config_ddl).
#   - `config.tenant` is populated (run 002_config_sync after web edits).
#   - Files are CSV with a header row, UTF-8, comma-delimited.
#
# All bronze columns are STRING. Silver does proper typing via the
# `config.tenant_source_field_map`.
#
# Tenant-slug hyphens are converted to underscores for the schema name
# (`acme-pharma` → `bronze_acme_pharma`) so SQL references don't need
# backtick-quoting. Source slugs are preserved everywhere else.

# %% [parameters]
DRY_RUN = False
TENANT_SLUGS: list[str] = []  # empty = all active tenants
SFTP_ROOT = "Files/sftp"

# Some source files use column names that Delta rejects by default —
# spaces, parens, slashes, etc. (e.g. IntegriChain 867 has columns like
# `Ship-From DEA/HIN/Customer Id` and `sum(867 Qty Sold (EU))`). Enable
# Delta column mapping at session level so any bronze table created here
# preserves the source-style names verbatim. Existing tables created
# before this change keep their original (sanitized-or-broken) shape; if
# any need to be rebuilt, drop them first.
spark.conf.set(
    "spark.databricks.delta.properties.defaults.columnMapping.mode", "name"
)
spark.conf.set(
    "spark.databricks.delta.properties.defaults.minReaderVersion", "2"
)
spark.conf.set(
    "spark.databricks.delta.properties.defaults.minWriterVersion", "5"
)

# %%
import uuid
from datetime import datetime, timezone
from pyspark.sql.functions import lit
from pyspark.sql.types import (
    LongType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

BATCH_ID = str(uuid.uuid4())
RUN_AT = datetime.now(timezone.utc)


def slug_to_schema(slug: str) -> str:
    return slug.replace("-", "_")


# Explicit schema so single-row log writes don't fail type inference on NULLs.
INGEST_LOG_SCHEMA = StructType([
    StructField("id", StringType(), False),
    StructField("tenant_id", StringType(), False),
    StructField("tenant_slug", StringType(), False),
    StructField("feed_name", StringType(), False),
    StructField("source_file", StringType(), False),
    StructField("file_size_bytes", LongType(), True),
    StructField("ingested_at", TimestampType(), False),
    StructField("row_count", LongType(), True),
    StructField("batch_id", StringType(), False),
    StructField("status", StringType(), False),
    StructField("error_message", StringType(), True),
])


# %%
# ops schema + ingest log (self-managing; no separate DDL notebook needed)
spark.sql("CREATE SCHEMA IF NOT EXISTS ops")
spark.sql("""
CREATE TABLE IF NOT EXISTS ops.sftp_ingest_log (
  id                STRING    NOT NULL,
  tenant_id         STRING    NOT NULL,
  tenant_slug       STRING    NOT NULL,
  feed_name         STRING    NOT NULL,
  source_file       STRING    NOT NULL,
  file_size_bytes   LONG,
  ingested_at       TIMESTAMP NOT NULL,
  row_count         BIGINT,
  batch_id          STRING    NOT NULL,
  status            STRING    NOT NULL,
  error_message     STRING
) USING DELTA
""")

# %%
# Active tenants (optionally filtered)
tenant_query = "SELECT id, slug FROM config.tenant WHERE status = 'active'"
if TENANT_SLUGS:
    slugs_in = ", ".join(f"'{s}'" for s in TENANT_SLUGS)
    tenant_query += f" AND slug IN ({slugs_in})"

tenants = [r.asDict() for r in spark.sql(tenant_query).collect()]
print(f"Tenants to scan: {[t['slug'] for t in tenants] or '(none)'}")

# %%
# Files already ingested successfully — used to skip re-processing
already_ingested = {
    r.source_file
    for r in spark.sql(
        "SELECT DISTINCT source_file FROM ops.sftp_ingest_log WHERE status = 'success'"
    ).collect()
}
print(f"Previously ingested files: {len(already_ingested)}")


# %%
def list_safe(path: str):
    """mssparkutils.fs.ls that returns [] instead of throwing when path is missing."""
    try:
        return mssparkutils.fs.ls(path)
    except Exception:
        return []


def log_outcome(
    tenant: dict,
    feed_name: str,
    file_path: str,
    size: int | None,
    row_count: int | None,
    status: str,
    err: str | None = None,
):
    row = [
        {
            "id": str(uuid.uuid4()),
            "tenant_id": tenant["id"],
            "tenant_slug": tenant["slug"],
            "feed_name": feed_name,
            "source_file": file_path,
            "file_size_bytes": size,
            "ingested_at": RUN_AT,
            "row_count": row_count,
            "batch_id": BATCH_ID,
            "status": status,
            "error_message": err,
        }
    ]
    (
        spark.createDataFrame(row, schema=INGEST_LOG_SCHEMA)
        .write.format("delta")
        .mode("append")
        .saveAsTable("ops.sftp_ingest_log")
    )


def ingest_csv(tenant: dict, feed_name: str, file_path: str) -> int:
    """Read one CSV file and append to bronze_<schema>.sftp_<feed>. Returns row count."""
    df = (
        spark.read
        .option("header", "true")
        .option("inferSchema", "false")
        .csv(file_path)
    )
    df = (
        df
        .withColumn("_ingested_at", lit(RUN_AT).cast(TimestampType()))
        .withColumn("_source_file", lit(file_path).cast(StringType()))
        .withColumn("_source_batch_id", lit(BATCH_ID).cast(StringType()))
    )

    rows = df.count()
    schema_name = f"bronze_{slug_to_schema(tenant['slug'])}"
    table_name = f"{schema_name}.sftp_{feed_name}"

    if DRY_RUN:
        print(f"  [DRY RUN] would write {rows} rows to {table_name}")
        return rows

    spark.sql(f"CREATE SCHEMA IF NOT EXISTS {schema_name}")
    (
        df.write
        .format("delta")
        .mode("append")
        .option("mergeSchema", "true")
        .saveAsTable(table_name)
    )
    return rows


# %%
# Main ingest loop
totals = {"success": 0, "failed": 0, "skipped": 0}

for tenant in tenants:
    slug = tenant["slug"]
    tenant_root = f"{SFTP_ROOT}/{slug}"
    feed_dirs = [f for f in list_safe(tenant_root) if f.isDir]

    if not feed_dirs:
        print(f"[{slug}] no SFTP feed folders under {tenant_root} — skipping")
        continue

    for feed in feed_dirs:
        feed_name = feed.name.rstrip("/")
        feed_path = f"{tenant_root}/{feed_name}"

        for entry in list_safe(feed_path):
            if entry.isDir or not entry.name.lower().endswith(".csv"):
                continue

            if entry.path in already_ingested:
                print(f"[{slug}/{feed_name}] {entry.name} — already ingested, skip")
                totals["skipped"] += 1
                continue

            print(f"[{slug}/{feed_name}] ingesting {entry.name} ...")
            try:
                rows = ingest_csv(tenant, feed_name, entry.path)
                if not DRY_RUN:
                    log_outcome(tenant, feed_name, entry.path, entry.size, rows, "success")
                totals["success"] += 1
                print(f"  -> {rows} rows")
            except Exception as e:
                err = str(e)[:500]
                log_outcome(tenant, feed_name, entry.path, None, None, "failed", err)
                totals["failed"] += 1
                print(f"  FAILED: {err}")

# %%
print("\n=== Ingest summary ===")
print(f"  success: {totals['success']}")
print(f"  failed:  {totals['failed']}")
print(f"  skipped: {totals['skipped']}")
print(f"  batch_id: {BATCH_ID}")


# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
