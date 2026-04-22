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

# # Bronze Veeva incremental ingest
#
# For each enabled tenant in `config.tenant_veeva`:
#   1. Determine the cursor — `MAX(extract_stop_time)` of any successful or
#      no-records row in `ops.veeva_ingest_log` for that tenant. If no cursor
#      exists, skip with a "run veeva_full_ingest first" message.
#   2. List incremental_directdata batches in [cursor, now-rounded-to-15m].
#   3. For each batch, in chronological order:
#        - skip if already in log with status='success'/'no_records'
#        - if record_count == 0, log as 'no_records' (advances cursor, no DL)
#        - else download, extract, **append** to bronze tables, log success
#
# Bronze is append-only (per ARCHITECTURE.md §2 — bronze is raw landing).
# Multiple versions of the same row accumulate over time, ordered by Veeva's
# `modified_date__v`. Silver build notebooks dedupe to current state.
#
# Append uses `mergeSchema=true` so new columns Veeva adds in incrementals
# extend the bronze table without breaking the write.
#
# Schedule via Fabric Data Pipeline — every 15-30 min is a reasonable cadence
# for "near-real-time" pharma data.
#
# Before running:
#   1. Run `veeva_full_ingest` at least once for the tenant (creates cursor)
#   2. Set `VEEVA_PASSWORDS` parameter

# CELL ********************

# Per-tenant passwords. Same dict shape as veeva_full_ingest. Set at runtime.
VEEVA_PASSWORDS: dict[str, str] = {}

# Optional: limit to specific tenants. Empty = process all enabled tenants.
TENANT_SLUGS: list[str] = []

# Skip extracts already logged (avoids reprocessing on re-runs).
SKIP_ALREADY_INGESTED = True

# Keep downloaded .tar.gz archives after extraction. Useful for replay/debug.
KEEP_ARCHIVES = True

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark",
# META   "tags": ["parameters"]
# META }

# MARKDOWN ********************

# ## Veeva Direct Data API client
#
# Inlined from `notebooks/lib/veeva_directdata.py`. Identical to what's in
# `veeva_full_ingest`. Keep them in sync until we package as a wheel.

# CELL ********************

import logging
import time
from dataclasses import dataclass
from typing import Literal

import requests

log = logging.getLogger(__name__)

ExtractType = Literal["full_directdata", "incremental_directdata", "log_directdata"]


@dataclass(frozen=True)
class FilepartDetail:
    filepart: int
    name: str
    size: int
    url: str | None = None


@dataclass(frozen=True)
class DirectDataExtract:
    name: str
    extract_type: str
    start_time: str
    stop_time: str
    record_count: int
    fileparts: int
    size: int
    filename: str | None = None
    filepart_details: tuple[FilepartDetail, ...] = ()


class VeevaAuthError(Exception):
    pass


class VeevaApiError(Exception):
    pass


class VeevaDirectData:
    def __init__(
        self,
        vault_dns: str,
        username: str,
        password: str,
        api_version: str = "v25.1",
        max_retries: int = 3,
        timeout_seconds: int = 60,
    ):
        self.vault_dns = vault_dns
        self.api_version = api_version
        self._username = username
        self._password = password
        self._session_id: str | None = None
        self._max_retries = max_retries
        self._timeout = timeout_seconds
        self._base_url = f"https://{vault_dns}/api/{api_version}"

    def authenticate(self) -> None:
        url = f"{self._base_url}/auth"
        body = {"username": self._username, "password": self._password}
        last_err: Exception | None = None
        for attempt in range(self._max_retries):
            try:
                r = requests.post(url, data=body, timeout=self._timeout)
                data = r.json()
                if data.get("responseStatus") != "SUCCESS":
                    raise VeevaAuthError(f"Auth failed: {data}")
                self._session_id = data["sessionId"]
                log.info("Authenticated to %s as %s", self.vault_dns, self._username)
                return
            except (requests.RequestException, ValueError) as e:
                last_err = e
                wait = 2 ** attempt
                log.warning("Auth attempt %d failed: %s — retrying in %ds", attempt + 1, e, wait)
                time.sleep(wait)
        raise VeevaAuthError(f"Authentication exhausted retries: {last_err}")

    def _request(self, method: str, path: str, **kwargs) -> requests.Response:
        if self._session_id is None:
            self.authenticate()
        url = f"{self._base_url}{path}"
        headers = {**kwargs.pop("headers", {}), "Authorization": self._session_id or ""}
        kwargs.setdefault("timeout", self._timeout)
        last_err: Exception | None = None
        for attempt in range(self._max_retries):
            try:
                r = requests.request(method, url, headers=headers, **kwargs)
                if r.status_code == 200 and "application/json" in r.headers.get("content-type", ""):
                    body = r.json()
                    if isinstance(body, dict) and body.get("responseStatus") == "FAILURE":
                        errors = body.get("errors", [])
                        if any(e.get("type") == "INVALID_SESSION_ID" for e in errors):
                            log.info("Session expired, re-authenticating")
                            self._session_id = None
                            self.authenticate()
                            headers["Authorization"] = self._session_id or ""
                            continue
                if r.status_code >= 500 or r.status_code == 429:
                    raise VeevaApiError(f"{method} {url} -> {r.status_code} {r.text[:200]}")
                return r
            except (requests.RequestException, VeevaApiError) as e:
                last_err = e
                wait = 2 ** attempt
                log.warning("%s %s attempt %d failed: %s — retrying in %ds",
                            method, path, attempt + 1, e, wait)
                time.sleep(wait)
        raise VeevaApiError(f"{method} {path} exhausted retries: {last_err}")

    def list_extracts(
        self,
        extract_type: ExtractType,
        start_time: str,
        stop_time: str,
    ) -> list[DirectDataExtract]:
        params = {"extract_type": extract_type, "start_time": start_time, "stop_time": stop_time}
        r = self._request("GET", "/services/directdata/files", params=params)
        body = r.json()
        if body.get("responseStatus") != "SUCCESS":
            raise VeevaApiError(f"list_extracts failed: {body}")
        out: list[DirectDataExtract] = []
        for item in body.get("data", []) or []:
            parts = tuple(
                FilepartDetail(
                    filepart=int(p.get("filepart", 1)),
                    name=p.get("name", ""),
                    size=int(p.get("size", 0)),
                    url=p.get("url"),
                )
                for p in (item.get("filepart_details") or [])
            )
            out.append(
                DirectDataExtract(
                    name=item.get("name", ""),
                    extract_type=item.get("extract_type", extract_type),
                    start_time=item.get("start_time", ""),
                    stop_time=item.get("stop_time", ""),
                    record_count=int(item.get("record_count", 0)),
                    fileparts=int(item.get("fileparts", 1)),
                    size=int(item.get("size", 0)),
                    filename=item.get("filename"),
                    filepart_details=parts,
                )
            )
        out.sort(key=lambda x: x.stop_time)
        return out

    def download_filepart(self, filepart_name: str) -> bytes:
        r = self._request("GET", f"/services/directdata/files/{filepart_name}", stream=False)
        if r.status_code != 200:
            raise VeevaApiError(f"download_filepart {filepart_name} -> {r.status_code}")
        return r.content

    def download_extract(self, extract: DirectDataExtract) -> bytes:
        if not extract.filepart_details:
            return self.download_filepart(f"{extract.name}.001")
        chunks: list[bytes] = []
        for part in sorted(extract.filepart_details, key=lambda p: p.filepart):
            log.info("Downloading filepart %d of %s (%d bytes)",
                     part.filepart, extract.name, part.size)
            chunks.append(self.download_filepart(part.name))
        return b"".join(chunks)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Setup: imports, run-scoped IDs, ops schema + log table (idempotent)
import os
import re
import shutil
import tarfile
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from pyspark.sql.functions import lit
from pyspark.sql.types import (
    IntegerType,
    LongType,
    StringType,
    StructField,
    StructType,
    TimestampType,
)

BATCH_ID = str(uuid.uuid4())
RUN_AT = datetime.now(timezone.utc)
FILES_ROOT = "/lakehouse/default/Files"

spark.sql("CREATE SCHEMA IF NOT EXISTS ops")
spark.sql("""
CREATE TABLE IF NOT EXISTS ops.veeva_ingest_log (
  id                     STRING    NOT NULL,
  tenant_id              STRING    NOT NULL,
  tenant_slug            STRING    NOT NULL,
  vault_dns              STRING    NOT NULL,
  extract_type           STRING    NOT NULL,
  extract_name           STRING    NOT NULL,
  extract_start_time     STRING,
  extract_stop_time      STRING    NOT NULL,
  record_count           BIGINT,
  fileparts              INT,
  total_size_bytes       BIGINT,
  download_started_at    TIMESTAMP,
  download_completed_at  TIMESTAMP,
  ingested_at            TIMESTAMP NOT NULL,
  status                 STRING    NOT NULL,
  tables_written         INT,
  rows_written           BIGINT,
  error_message          STRING,
  batch_id               STRING    NOT NULL
) USING DELTA
""")

INGEST_LOG_SCHEMA = StructType([
    StructField("id", StringType(), False),
    StructField("tenant_id", StringType(), False),
    StructField("tenant_slug", StringType(), False),
    StructField("vault_dns", StringType(), False),
    StructField("extract_type", StringType(), False),
    StructField("extract_name", StringType(), False),
    StructField("extract_start_time", StringType(), True),
    StructField("extract_stop_time", StringType(), False),
    StructField("record_count", LongType(), True),
    StructField("fileparts", IntegerType(), True),
    StructField("total_size_bytes", LongType(), True),
    StructField("download_started_at", TimestampType(), True),
    StructField("download_completed_at", TimestampType(), True),
    StructField("ingested_at", TimestampType(), False),
    StructField("status", StringType(), False),
    StructField("tables_written", IntegerType(), True),
    StructField("rows_written", LongType(), True),
    StructField("error_message", StringType(), True),
    StructField("batch_id", StringType(), False),
])

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Helpers

def slug_to_schema(slug: str) -> str:
    return slug.replace("-", "_")


def safe_table_stem(filename_no_ext: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "_", filename_no_ext)


def resolve_password(secret_uri: str, slug: str) -> str:
    if secret_uri.startswith("env:"):
        if slug in VEEVA_PASSWORDS and VEEVA_PASSWORDS[slug]:
            return VEEVA_PASSWORDS[slug]
        raise RuntimeError(
            f"VEEVA_PASSWORDS['{slug}'] is not set in the parameters cell."
        )
    if secret_uri.startswith("keyvault:"):
        raise NotImplementedError("Key Vault password resolution not yet implemented")
    raise RuntimeError(f"Unknown secret URI scheme: {secret_uri}")


def already_ingested(tenant_id: str, extract_name: str) -> bool:
    rows = spark.sql(f"""
      SELECT 1 FROM ops.veeva_ingest_log
      WHERE tenant_id = '{tenant_id}'
        AND extract_name = '{extract_name}'
        AND status IN ('success', 'no_records')
      LIMIT 1
    """).collect()
    return len(rows) > 0


def get_cursor(tenant_id: str) -> str | None:
    """Latest stop_time for any logged ingest (success OR no_records).

    no_records counts because Veeva published an empty batch at that time —
    we still want the cursor to advance past it.
    """
    rows = spark.sql(f"""
      SELECT MAX(extract_stop_time) AS cursor
      FROM ops.veeva_ingest_log
      WHERE tenant_id = '{tenant_id}'
        AND status IN ('success', 'no_records')
    """).collect()
    return rows[0].cursor if rows and rows[0].cursor else None


def round_down_15(dt_utc: datetime) -> datetime:
    return dt_utc.replace(minute=(dt_utc.minute // 15) * 15, second=0, microsecond=0)


def fmt_veeva(dt_utc: datetime) -> str:
    return dt_utc.strftime("%Y-%m-%dT%H:%MZ")


def log_ingest(
    tenant_id: str,
    tenant_slug: str,
    vault_dns: str,
    extract_type: str,
    extract_name: str,
    extract_start_time: str | None,
    extract_stop_time: str,
    *,
    record_count: int | None = None,
    fileparts: int | None = None,
    total_size_bytes: int | None = None,
    download_started_at: datetime | None = None,
    download_completed_at: datetime | None = None,
    status: str,
    tables_written: int | None = None,
    rows_written: int | None = None,
    error_message: str | None = None,
):
    row = [{
        "id": str(uuid.uuid4()),
        "tenant_id": tenant_id,
        "tenant_slug": tenant_slug,
        "vault_dns": vault_dns,
        "extract_type": extract_type,
        "extract_name": extract_name,
        "extract_start_time": extract_start_time,
        "extract_stop_time": extract_stop_time,
        "record_count": record_count,
        "fileparts": fileparts,
        "total_size_bytes": total_size_bytes,
        "download_started_at": download_started_at,
        "download_completed_at": download_completed_at,
        "ingested_at": RUN_AT,
        "status": status,
        "tables_written": tables_written,
        "rows_written": rows_written,
        "error_message": error_message,
        "batch_id": BATCH_ID,
    }]
    (spark.createDataFrame(row, schema=INGEST_LOG_SCHEMA)
        .write.format("delta").mode("append").saveAsTable("ops.veeva_ingest_log"))

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Download + extract + append-to-bronze. Returns (tables_written, rows_written).
DATA_SUFFIXES = (".csv", ".parquet")


def find_category_in(root: Path, name: str) -> Path | None:
    for child in root.iterdir():
        if child.is_dir() and child.name.lower() == name.lower():
            return child
    return None


def root_has_categories(root: Path) -> bool:
    return any(
        find_category_in(root, c) is not None
        for c in ("Object", "Metadata", "Picklist")
    )


def discover_tables(category_dir: Path | None) -> list[tuple[str, Path]]:
    if category_dir is None or not category_dir.exists():
        return []
    out: list[tuple[str, Path]] = []
    for entry in sorted(category_dir.iterdir(), key=lambda p: p.name):
        if entry.is_dir():
            has_data = any(
                child.is_file() and child.suffix.lower() in DATA_SUFFIXES
                for child in entry.iterdir()
            )
            if has_data:
                out.append((entry.name, entry))
        elif entry.suffix.lower() in DATA_SUFFIXES:
            out.append((entry.stem, entry))
    return out


def read_data(path: Path):
    if path.is_dir():
        sample = next(
            (f for f in path.iterdir()
             if f.is_file() and f.suffix.lower() in DATA_SUFFIXES),
            None,
        )
        if sample is None:
            raise RuntimeError(f"No data files in {path}")
        suffix = sample.suffix.lower()
    else:
        suffix = path.suffix.lower()

    relative = str(path.relative_to(FILES_ROOT)).replace("\\", "/")
    spark_path = f"Files/{relative}"

    if suffix == ".parquet":
        return spark.read.parquet(spark_path)
    if suffix == ".csv":
        return (
            spark.read
            .option("header", "true")
            .option("inferSchema", "false")
            .option("multiLine", "true")
            .option("escape", '"')
            .option("quote", '"')
            .option("nullValue", "")
            .csv(spark_path)
        )
    raise RuntimeError(f"Unknown data extension {suffix} for {path}")


def append_extract_to_bronze(
    client: VeevaDirectData,
    extract: DirectDataExtract,
    tenant_slug: str,
    schema_name: str,
) -> tuple[int, int]:
    """Download an extract, append all its tables to bronze. Returns (tables, rows)."""
    archive_dir_rel = f"veeva/{tenant_slug}/incremental/{extract.name}"
    archive_dir_abs = f"{FILES_ROOT}/{archive_dir_rel}"
    archive_path = f"{archive_dir_abs}/directdata-{extract.name}.tar.gz"
    extract_path = f"{archive_dir_abs}/extract"
    os.makedirs(archive_dir_abs, exist_ok=True)

    archive_bytes = client.download_extract(extract)
    with open(archive_path, "wb") as f:
        f.write(archive_bytes)

    if os.path.exists(extract_path):
        shutil.rmtree(extract_path)
    os.makedirs(extract_path, exist_ok=True)
    with tarfile.open(archive_path, "r:gz") as tar:
        tar.extractall(extract_path)

    extract_dir = Path(extract_path)
    if root_has_categories(extract_dir):
        inner = extract_dir
    else:
        wrapped = [p for p in extract_dir.iterdir() if p.is_dir() and root_has_categories(p)]
        if len(wrapped) == 1:
            inner = wrapped[0]
        else:
            raise RuntimeError(
                f"Couldn't locate Object/Metadata/Picklist under {extract_path}. "
                f"Top-level entries: {[p.name for p in extract_dir.iterdir()]}"
            )

    tables_written = 0
    rows_written = 0
    for category, prefix in [("Object", "veeva_obj"), ("Metadata", "veeva_meta"), ("Picklist", "veeva_pl")]:
        category_dir = find_category_in(inner, category)
        for table_stem, data_path in discover_tables(category_dir):
            stem = safe_table_stem(table_stem)
            table_name = f"{schema_name}.{prefix}_{stem}"

            df = read_data(data_path)
            df = (df
                .withColumn("_ingested_at", lit(RUN_AT).cast(TimestampType()))
                .withColumn("_source_extract_name", lit(extract.name).cast(StringType()))
                .withColumn("_source_extract_type", lit(extract.extract_type).cast(StringType()))
                .withColumn("_source_batch_id", lit(BATCH_ID).cast(StringType())))

            row_count = df.count()
            (df.write
                .format("delta")
                .mode("append")
                .option("mergeSchema", "true")
                .saveAsTable(table_name))
            tables_written += 1
            rows_written += row_count

    if not KEEP_ARCHIVES:
        try:
            os.remove(archive_path)
        except OSError:
            pass

    return (tables_written, rows_written)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Per-tenant incremental loop

def ingest_tenant_incremental(tenant: dict) -> dict:
    slug = tenant["slug"]
    tenant_id = tenant["id"]
    vault_dns = tenant["vault_domain"]
    schema_name = f"bronze_{slug_to_schema(slug)}"

    cursor = get_cursor(tenant_id)
    if not cursor:
        msg = "no cursor — run veeva_full_ingest first"
        print(f"[{slug}] {msg}")
        return {"status": "no_cursor", "msg": msg}

    spark.sql(f"CREATE SCHEMA IF NOT EXISTS {schema_name}")

    # Auth
    password = resolve_password(tenant["password_secret_uri"], slug)
    client = VeevaDirectData(
        vault_dns=vault_dns,
        username=tenant["username"],
        password=password,
    )
    client.authenticate()

    # Window
    now = datetime.now(timezone.utc)
    stop = fmt_veeva(round_down_15(now))
    print(f"[{slug}] cursor={cursor}  stop={stop}")
    if cursor >= stop:
        print(f"[{slug}] cursor is at or past current 15-min boundary, nothing to do")
        return {"status": "ok", "counts": {"success": 0, "skipped": 0, "no_records": 0, "failed": 0}}

    extracts = client.list_extracts("incremental_directdata", cursor, stop)
    print(f"[{slug}] {len(extracts)} batches available in window")

    counts = {"success": 0, "skipped": 0, "no_records": 0, "failed": 0}

    for extract in extracts:
        if SKIP_ALREADY_INGESTED and already_ingested(tenant_id, extract.name):
            counts["skipped"] += 1
            continue

        # Empty batch — log and advance cursor without download
        if extract.record_count == 0:
            log_ingest(
                tenant_id, slug, vault_dns,
                extract_type=extract.extract_type,
                extract_name=extract.name,
                extract_start_time=extract.start_time,
                extract_stop_time=extract.stop_time,
                record_count=0,
                fileparts=extract.fileparts,
                total_size_bytes=extract.size,
                status="no_records",
            )
            counts["no_records"] += 1
            continue

        # Process
        download_started = datetime.now(timezone.utc)
        try:
            tables, rows = append_extract_to_bronze(client, extract, slug, schema_name)
            download_completed = datetime.now(timezone.utc)
            log_ingest(
                tenant_id, slug, vault_dns,
                extract_type=extract.extract_type,
                extract_name=extract.name,
                extract_start_time=extract.start_time,
                extract_stop_time=extract.stop_time,
                record_count=extract.record_count,
                fileparts=extract.fileparts,
                total_size_bytes=extract.size,
                download_started_at=download_started,
                download_completed_at=download_completed,
                status="success",
                tables_written=tables,
                rows_written=rows,
            )
            counts["success"] += 1
            print(f"[{slug}] +{extract.name} +{rows:,} rows across {tables} tables")
        except Exception as e:
            err = str(e)[:500]
            log_ingest(
                tenant_id, slug, vault_dns,
                extract_type=extract.extract_type,
                extract_name=extract.name,
                extract_start_time=extract.start_time,
                extract_stop_time=extract.stop_time,
                record_count=extract.record_count,
                fileparts=extract.fileparts,
                total_size_bytes=extract.size,
                status="failed",
                error_message=err,
            )
            counts["failed"] += 1
            print(f"[{slug}] FAILED on {extract.name}: {err}")

    return {"status": "ok", "counts": counts}

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Get target tenants
tenant_query = """
  SELECT t.id, t.slug, tv.vault_domain, tv.username, tv.password_secret_uri
  FROM config.tenant t
  JOIN config.tenant_veeva tv ON tv.tenant_id = t.id
  WHERE t.status = 'active' AND tv.enabled = true
"""
if TENANT_SLUGS:
    in_clause = ", ".join(f"'{s}'" for s in TENANT_SLUGS)
    tenant_query += f" AND t.slug IN ({in_clause})"

tenants = [r.asDict() for r in spark.sql(tenant_query).collect()]
print(f"Tenants to process: {[t['slug'] for t in tenants] or '(none)'}")

if not tenants:
    raise RuntimeError("No enabled Veeva tenants found.")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Run loop — each tenant isolated
results: dict[str, dict] = {}
for tenant in tenants:
    slug = tenant["slug"]
    try:
        results[slug] = ingest_tenant_incremental(tenant)
    except Exception as e:
        err = str(e)[:500]
        print(f"[{slug}] tenant-level FAILURE: {err}")
        results[slug] = {"status": "tenant_failed", "msg": err}

# Summary
print("\n=== Veeva incremental ingest summary ===")
for slug, result in results.items():
    if result.get("status") in ("no_cursor", "tenant_failed"):
        print(f"  [{slug}] {result.get('status')}: {result.get('msg')}")
    else:
        c = result["counts"]
        print(f"  [{slug}] success={c['success']}  skipped={c['skipped']}  no_records={c['no_records']}  failed={c['failed']}")
print(f"  batch_id: {BATCH_ID}")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
