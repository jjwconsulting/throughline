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

# # Bronze Veeva FULL ingest
#
# For each enabled tenant in `config.tenant_veeva`:
#   1. Authenticate to the tenant's Vault
#   2. List FULL Direct Data extracts; pick the most recent
#   3. Skip if already in `ops.veeva_ingest_log` with status='success'
#   4. Download the .tar.gz (multi-part if needed)
#   5. Extract in place under `Files/veeva/<slug>/full/<extract_name>/`
#   6. For each Parquet in Object/, Metadata/, Picklist/, overwrite a
#      `bronze_<slug>.veeva_(obj|meta|pl)_<name>` Delta table with ingest
#      metadata columns appended
#   7. Log outcome to `ops.veeva_ingest_log`
#
# Multi-tenant from day one. Idempotent: skips already-ingested extracts.
# Each tenant runs in isolation — one tenant's failure doesn't block others.
#
# Phase 2 scope: FULL only. Phase 3 will add incremental + cursor.
#
# Before running:
#   1. Run `packages/db/scripts/seed-tenant-veeva-fennecpharma.sql` in Supabase
#   2. Run `config_sync` notebook (push tenant_veeva to Fabric)
#   3. Set `VEEVA_PASSWORDS` in the parameters cell

# CELL ********************

# Per-tenant passwords. Key by tenant slug. Set at runtime; never commit.
# Example: VEEVA_PASSWORDS = {"acme-pharma": "your-password-here"}
VEEVA_PASSWORDS: dict[str, str] = {}

# Optional: limit to specific tenants. Empty = process all enabled tenants.
TENANT_SLUGS: list[str] = []

# Skip extracts already in ops.veeva_ingest_log with status='success'.
# Set False to force re-ingest of the latest FULL.
SKIP_ALREADY_INGESTED = True

# Keep the downloaded .tar.gz after extraction. Useful for replay/debug,
# costs storage. Set False to delete after successful extraction.
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
# Inlined from `notebooks/lib/veeva_directdata.py`. Keep them in sync — when
# updating client behavior, edit both files. Long-term: package as a wheel
# in a Fabric custom environment.

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
    """Veeva Direct Data API client. Auth via session ID; auto re-auth on
    INVALID_SESSION_ID. Retries on 5xx/429/connection errors with exponential
    backoff."""

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

# Setup: imports, run-scoped IDs, ops schema + log table
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

# Explicit schema so single-row log writes don't fail on NULL inference.
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
    """Map a secret URI scheme to a runtime value.

    Schemes:
      env:NAME       -> look up VEEVA_PASSWORDS[slug] (we use the param dict
                        rather than os.environ because Fabric notebook params
                        are not env vars; the URI is a forward-compatible
                        marker for the eventual Key Vault migration)
      keyvault:URL   -> NotImplemented for now
    """
    if secret_uri.startswith("env:"):
        if slug in VEEVA_PASSWORDS and VEEVA_PASSWORDS[slug]:
            return VEEVA_PASSWORDS[slug]
        raise RuntimeError(
            f"VEEVA_PASSWORDS['{slug}'] is not set in the parameters cell. "
            f"Tenant config expects secret URI '{secret_uri}'."
        )
    if secret_uri.startswith("keyvault:"):
        raise NotImplementedError("Key Vault password resolution not yet implemented")
    raise RuntimeError(f"Unknown secret URI scheme: {secret_uri}")


def already_ingested(tenant_id: str, extract_name: str) -> bool:
    rows = spark.sql(f"""
      SELECT 1 FROM ops.veeva_ingest_log
      WHERE tenant_id = '{tenant_id}'
        AND extract_name = '{extract_name}'
        AND status = 'success'
      LIMIT 1
    """).collect()
    return len(rows) > 0


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

# Get target tenants from synced config
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
    raise RuntimeError("No enabled Veeva tenants found. Did you seed config.tenant_veeva and re-run config_sync?")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Per-tenant ingest

def ingest_tenant(tenant: dict) -> tuple[str, int, int]:
    """Returns (status, tables_written, rows_written)."""
    slug = tenant["slug"]
    tenant_id = tenant["id"]
    vault_dns = tenant["vault_domain"]
    schema_name = f"bronze_{slug_to_schema(slug)}"

    spark.sql(f"CREATE SCHEMA IF NOT EXISTS {schema_name}")

    # Auth
    password = resolve_password(tenant["password_secret_uri"], slug)
    client = VeevaDirectData(
        vault_dns=vault_dns,
        username=tenant["username"],
        password=password,
    )
    client.authenticate()

    # Find latest FULL
    now = datetime.now(timezone.utc)
    window_stop = (now + timedelta(days=1)).strftime("%Y-%m-%dT%H:%MZ")
    extracts = client.list_extracts("full_directdata", "2000-01-01T00:00Z", window_stop)
    if not extracts:
        log_ingest(tenant_id, slug, vault_dns, "full_directdata", "<none>",
                   None, "", status="failed",
                   error_message="No FULL extracts available")
        print(f"[{slug}] no FULL extracts available")
        return ("failed", 0, 0)
    latest = extracts[-1]
    print(f"[{slug}] latest FULL: {latest.name}  records={latest.record_count:,}  size={latest.size:,}")

    # Skip if done
    if SKIP_ALREADY_INGESTED and already_ingested(tenant_id, latest.name):
        print(f"[{slug}] {latest.name} already ingested, skipping")
        return ("skipped", 0, 0)

    # Download
    download_started = datetime.now(timezone.utc)
    archive_dir_rel = f"veeva/{slug}/full/{latest.name}"
    archive_dir_abs = f"{FILES_ROOT}/{archive_dir_rel}"
    archive_path = f"{archive_dir_abs}/directdata-{latest.name}.tar.gz"
    extract_path = f"{archive_dir_abs}/extract"
    os.makedirs(archive_dir_abs, exist_ok=True)

    print(f"[{slug}] downloading {latest.size:,} bytes ...")
    archive_bytes = client.download_extract(latest)
    with open(archive_path, "wb") as f:
        f.write(archive_bytes)
    download_completed = datetime.now(timezone.utc)
    print(f"[{slug}] download complete in {(download_completed - download_started).total_seconds():.1f}s")

    # Extract
    print(f"[{slug}] extracting ...")
    if os.path.exists(extract_path):
        shutil.rmtree(extract_path)
    os.makedirs(extract_path, exist_ok=True)
    with tarfile.open(archive_path, "r:gz") as tar:
        tar.extractall(extract_path)

    # Locate the folder containing Object/Metadata/Picklist. Veeva archives
    # vary: some wrap contents in `directdata-<name>/`, some put them at the
    # root. Subfolders may also be lowercase. Be flexible.
    extract_dir = Path(extract_path)

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

    if root_has_categories(extract_dir):
        inner = extract_dir
    else:
        wrapped = [p for p in extract_dir.iterdir() if p.is_dir() and root_has_categories(p)]
        if len(wrapped) == 1:
            inner = wrapped[0]
        else:
            raise RuntimeError(
                f"Couldn't locate Object/Metadata/Picklist under {extract_path}. "
                f"Top-level entries: {[p.name for p in extract_dir.iterdir()]}. "
                f"Wrapped candidates: {[p.name for p in wrapped]}"
            )
    print(f"[{slug}] extracted layout root: {inner}")

    # Diagnostic: show what's inside (truncated)
    def list_tree(d: Path, depth: int, prefix: str = ""):
        if depth <= 0:
            return
        entries = sorted(d.iterdir(), key=lambda p: p.name)[:20]
        for entry in entries:
            marker = "/" if entry.is_dir() else ""
            print(f"  {prefix}{entry.name}{marker}")
            if entry.is_dir() and depth > 1:
                list_tree(entry, depth - 1, prefix + "  ")

    print(f"[{slug}] layout (depth 2):")
    list_tree(inner, depth=2)

    # Discover tables per category. Each table is either:
    #   - a single .csv or .parquet file inside the category (flat layout), or
    #   - a subfolder of .csv or .parquet parts (nested layout)
    # Veeva Direct Data ships CSV by default; we accept both for forward compat.
    DATA_SUFFIXES = (".csv", ".parquet")

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
        """Read a CSV or Parquet file (or a folder of them) into a DataFrame.

        Bronze keeps everything as STRING so silver can do its own typing.
        CSV options handle multiline string fields (descriptions, notes) and
        embedded quotes that show up in Veeva extracts.
        """
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

    # Process Object/, Metadata/, Picklist/ (case-insensitive)
    tables_written = 0
    rows_written = 0
    for category, prefix in [("Object", "veeva_obj"), ("Metadata", "veeva_meta"), ("Picklist", "veeva_pl")]:
        category_dir = find_category_in(inner, category)
        tables = discover_tables(category_dir)
        if not tables:
            print(f"[{slug}]   no {category} tables found")
            continue
        for table_stem, data_path in tables:
            stem = safe_table_stem(table_stem)
            table_name = f"{schema_name}.{prefix}_{stem}"

            df = read_data(data_path)
            df = (df
                .withColumn("_ingested_at", lit(RUN_AT).cast(TimestampType()))
                .withColumn("_source_extract_name", lit(latest.name).cast(StringType()))
                .withColumn("_source_extract_type", lit("full_directdata").cast(StringType()))
                .withColumn("_source_batch_id", lit(BATCH_ID).cast(StringType())))

            row_count = df.count()
            (df.write
                .format("delta")
                .mode("overwrite")
                .option("overwriteSchema", "true")
                .saveAsTable(table_name))
            tables_written += 1
            rows_written += row_count
            print(f"[{slug}]   {table_name}  rows={row_count:,}")

    if tables_written == 0:
        # Don't poison the cursor — log as failed so re-runs retry.
        log_ingest(
            tenant_id, slug, vault_dns,
            extract_type="full_directdata",
            extract_name=latest.name,
            extract_start_time=latest.start_time,
            extract_stop_time=latest.stop_time,
            record_count=latest.record_count,
            fileparts=latest.fileparts,
            total_size_bytes=latest.size,
            download_started_at=download_started,
            download_completed_at=download_completed,
            status="failed",
            error_message=(
                f"Extract decompressed but no tables discovered. "
                f"Inspect contents of {inner} to debug layout."
            ),
        )
        return ("failed", 0, 0)

    # Cleanup
    if not KEEP_ARCHIVES:
        try:
            os.remove(archive_path)
        except OSError:
            pass

    log_ingest(
        tenant_id, slug, vault_dns,
        extract_type="full_directdata",
        extract_name=latest.name,
        extract_start_time=latest.start_time,
        extract_stop_time=latest.stop_time,
        record_count=latest.record_count,
        fileparts=latest.fileparts,
        total_size_bytes=latest.size,
        download_started_at=download_started,
        download_completed_at=download_completed,
        status="success",
        tables_written=tables_written,
        rows_written=rows_written,
    )
    return ("success", tables_written, rows_written)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Run loop — each tenant isolated, failures don't cascade
totals = {"success": 0, "skipped": 0, "failed": 0}
for tenant in tenants:
    slug = tenant["slug"]
    try:
        status, tables, rows = ingest_tenant(tenant)
        totals[status] = totals.get(status, 0) + 1
        if status == "success":
            print(f"[{slug}] ✓ {tables} tables, {rows:,} rows")
    except Exception as e:
        err = str(e)[:500]
        print(f"[{slug}] FAILED: {err}")
        totals["failed"] += 1
        try:
            log_ingest(
                tenant["id"], tenant["slug"], tenant["vault_domain"],
                extract_type="full_directdata",
                extract_name="<none>",
                extract_start_time=None,
                extract_stop_time="",
                status="failed",
                error_message=err,
            )
        except Exception as log_e:
            print(f"[{slug}] (also failed to log: {log_e})")

print("\n=== Veeva FULL ingest summary ===")
print(f"  success: {totals.get('success', 0)}")
print(f"  skipped: {totals.get('skipped', 0)}")
print(f"  failed:  {totals.get('failed', 0)}")
print(f"  batch_id: {BATCH_ID}")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
