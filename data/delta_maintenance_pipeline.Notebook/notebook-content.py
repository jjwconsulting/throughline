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

# # Pipeline: delta_maintenance
#
# Global pipeline. Periodic delta-table housekeeping:
#   - OPTIMIZE              compacts small files into larger ones
#   - VACUUM RETAIN 168     removes file versions older than 7 days
#
# Cadence: weekly Sunday ~4am, AFTER weekly_full_refresh.
#
# Doesn't use run_orchestrator since the unit of work is a SQL command
# per table, not a child notebook. Records its own pipeline_run row.
#
# Helpers below are inlined from the same shape used by every
# orchestrator notebook — keep in sync if you edit one, edit all.

# CELL ********************

import json
import time
from datetime import datetime, timezone

import requests

SUPABASE_URL       = "https://zucvjyhnqsjuryqxgqzb.supabase.co"
PIPELINE_RUN_TABLE = "pipeline_run"

_secrets_path = "Files/secrets/pipeline_config.json"
_secrets = json.loads(mssparkutils.fs.head(_secrets_path, 8192))
SUPABASE_SERVICE_ROLE_KEY = _secrets["supabase_service_role_key"]

_SUPABASE_HEADERS = {
    "apikey":        SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
    "Content-Type":  "application/json",
    "Prefer":        "return=representation",
}


def record_pipeline_run_start(kind, scope="global", tenant_id=None, triggered_by="schedule"):
    payload = {
        "kind": kind, "scope": scope, "tenant_id": tenant_id,
        "status": "running", "triggered_by": triggered_by,
    }
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/{PIPELINE_RUN_TABLE}",
            headers=_SUPABASE_HEADERS, json=payload, timeout=30,
        )
        resp.raise_for_status()
        return resp.json()[0]["id"]
    except Exception as exc:
        print(f"⚠ pipeline_run start writeback failed: {exc}")
        return None


def record_pipeline_run_finish(run_id, status, step_metrics=None, error=None, message=None):
    if not run_id:
        return
    payload = {
        "status": status,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "step_metrics": json.dumps(step_metrics) if step_metrics else None,
        "error": error, "message": message,
    }
    try:
        resp = requests.patch(
            f"{SUPABASE_URL}/rest/v1/{PIPELINE_RUN_TABLE}?id=eq.{run_id}",
            headers=_SUPABASE_HEADERS, json=payload, timeout=30,
        )
        resp.raise_for_status()
    except Exception as exc:
        print(f"⚠ pipeline_run finish writeback failed: {exc}")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

TABLES = [
    "silver.picklist",
    "silver.hcp",
    "silver.hco",
    "silver.user",
    "silver.territory",
    "silver.account_territory",
    "silver.user_territory",
    "silver.call",
    "silver.sale",
    "silver.account_xref",
    "gold.dim_date",
    "gold.dim_hcp",
    "gold.dim_hco",
    "gold.dim_user",
    "gold.dim_account",
    "gold.fact_call",
    "gold.fact_sale",
    "gold.fact_goal",
]

VACUUM_RETAIN_HOURS = 168

# CELL ********************

run_id = record_pipeline_run_start(
    kind="delta_maintenance", scope="global", tenant_id=None, triggered_by="schedule",
)

step_metrics = {}
overall_start = time.time()
failed_table = None
error_text = None

for table in TABLES:
    metric = {"status": "ok"}
    table_start = time.time()
    try:
        if not spark.catalog.tableExists(table):
            metric["status"] = "skipped"
            metric["reason"] = "table_not_found"
            step_metrics[table] = metric
            print(f"~ {table}: skipped (not found)")
            continue

        opt_result = spark.sql(f"OPTIMIZE {table}").collect()
        if opt_result:
            row = opt_result[0].asDict()
            if "metrics" in row and isinstance(row["metrics"], dict):
                metric["optimize"] = {
                    "files_added":   row["metrics"].get("numFilesAdded"),
                    "files_removed": row["metrics"].get("numFilesRemoved"),
                }

        spark.sql(f"VACUUM {table} RETAIN {VACUUM_RETAIN_HOURS} HOURS").collect()

        metric["duration_s"] = round(time.time() - table_start, 1)
        step_metrics[table] = metric
        print(f"✓ {table}: OPTIMIZE+VACUUM in {metric['duration_s']}s")
    except Exception as exc:
        failed_table = table
        error_text = f"Failed on {table}: {exc}"
        metric["status"] = "error"
        metric["error"] = str(exc)
        metric["duration_s"] = round(time.time() - table_start, 1)
        step_metrics[table] = metric
        print(f"✗ {table}: FAILED — {exc}")

elapsed = time.time() - overall_start
ok_count = sum(1 for m in step_metrics.values() if m.get("status") == "ok")
err_count = sum(1 for m in step_metrics.values() if m.get("status") == "error")
skip_count = sum(1 for m in step_metrics.values() if m.get("status") == "skipped")
summary = f"{ok_count} OK, {err_count} errors, {skip_count} skipped in {elapsed:.1f}s"

if err_count > 0:
    record_pipeline_run_finish(
        run_id, "failed", step_metrics=step_metrics, error=error_text, message=summary,
    )
else:
    record_pipeline_run_finish(
        run_id, "succeeded", step_metrics=step_metrics, message=summary,
    )

print(f"\n=== delta_maintenance finished — {summary} ===")
mssparkutils.notebook.exit(summary)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
