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

# # Pipeline: mapping_propagate
# Tenant-scoped pipeline. Triggered by the "Run sync now" button on
# /admin/mappings (web app). Web action passes pipeline_run_id +
# tenant_id + triggered_by as notebook parameters; this notebook updates
# the row the web already inserted instead of double-writing.
# Steps: config_sync → silver_account_xref_build → gold_fact_sale_build
# Scheduled? No — daily incremental_refresh re-runs these same steps as
# part of the broader chain. This notebook is only for the
# admin-triggered "I just saved mappings, push them now" path.
# ---
# Pipeline helpers (Supabase REST writeback to pipeline_run).
# Inlined in every orchestrator notebook because Fabric doesn't support
# Databricks-style `# MAGIC %run` for shared modules. Keep these in sync
# with the copies in incremental_refresh / weekly_full_refresh /
# delta_maintenance — same shape across all four.

# CELL ********************

import json
import time
import traceback
from datetime import datetime, timezone

import requests

# Supabase target. URL safe to commit; service-role key loaded from the
# lakehouse Files folder (excluded from git-sync).
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
        if resp.status_code >= 300:
            print(f"⚠ pipeline_run start writeback failed: HTTP {resp.status_code}")
            print(f"   request body: {payload}")
            print(f"   response body: {resp.text}")
            return None
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


def _update_pipeline_run_status(run_id, status):
    if not run_id:
        return
    try:
        resp = requests.patch(
            f"{SUPABASE_URL}/rest/v1/{PIPELINE_RUN_TABLE}?id=eq.{run_id}",
            headers=_SUPABASE_HEADERS, json={"status": status}, timeout=30,
        )
        resp.raise_for_status()
    except Exception as exc:
        print(f"⚠ pipeline_run status update failed: {exc}")


def find_recent_queued_run(kind, max_age_minutes=5):
    """
    Polling-based adoption of a recently-queued web-triggered run.
    Fabric's parameter cell mechanism strips the "parameters" tag on
    git-sync round-trips, so the web → notebook handoff via
    executionData.parameters is unreliable. Instead, the web action
    inserts the row at status='queued', and the notebook polls here at
    startup to find + adopt it. Falls back to creating a fresh row if
    no queued row is found.

    max_age_minutes guards against adopting stale rows (e.g. from a web
    trigger whose notebook job never started due to capacity).
    """
    from datetime import timedelta
    try:
        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=max_age_minutes)).isoformat()
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/{PIPELINE_RUN_TABLE}",
            headers=_SUPABASE_HEADERS,
            params={
                "kind":       f"eq.{kind}",
                "status":     "eq.queued",
                "created_at": f"gte.{cutoff}",
                "order":      "created_at.desc",
                "limit":      "1",
            },
            timeout=30,
        )
        resp.raise_for_status()
        rows = resp.json()
        if rows:
            return rows[0]
    except Exception as exc:
        print(f"⚠ find_recent_queued_run failed: {exc}")
    return None


def run_step(step_name, timeout_s=600):
    start = time.time()
    try:
        exit_value = mssparkutils.notebook.run(step_name, timeout_s)
        duration = time.time() - start
        print(f"✓ {step_name} OK in {duration:.1f}s — {exit_value}")
        return {"status": "ok", "duration_s": round(duration, 1), "exit_value": str(exit_value)}
    except Exception as exc:
        duration = time.time() - start
        print(f"✗ {step_name} FAILED after {duration:.1f}s — {exc}")
        exc._step_metrics = {"status": "error", "duration_s": round(duration, 1), "error": str(exc)}
        raise


def run_orchestrator(pipeline_kind, steps, scope="global", tenant_id=None,
                     triggered_by="schedule", step_timeout_s=600, pipeline_run_id=None):
    print(f"=== {pipeline_kind} ({scope}) started ===")
    pipeline_start = time.time()
    if pipeline_run_id:
        run_id = pipeline_run_id
        _update_pipeline_run_status(run_id, "running")
        print(f"using web-supplied pipeline_run_id: {run_id}")
    else:
        run_id = record_pipeline_run_start(
            kind=pipeline_kind, scope=scope, tenant_id=tenant_id, triggered_by=triggered_by,
        )

    step_metrics = {}
    try:
        for step in steps:
            print(f"\n→ Running {step}...")
            step_metrics[step] = run_step(step, step_timeout_s)
        elapsed = time.time() - pipeline_start
        message = f"OK in {elapsed:.1f}s across {len(steps)} steps"
        print(f"\n=== {pipeline_kind} finished — {message} ===")
        record_pipeline_run_finish(run_id, "succeeded", step_metrics=step_metrics, message=message)
        return message
    except Exception as exc:
        if hasattr(exc, "_step_metrics"):
            failed_step = next((s for s in steps if s not in step_metrics), "unknown")
            step_metrics[failed_step] = exc._step_metrics
        elapsed = time.time() - pipeline_start
        error_text = f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}"
        message = f"FAILED after {elapsed:.1f}s"
        print(f"\n=== {pipeline_kind} {message} ===")
        record_pipeline_run_finish(run_id, "failed", step_metrics=step_metrics,
                                   error=error_text, message=message)
        raise

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Parameter cell — overridable by the Fabric REST API trigger via
# executionData.parameters. The "parameters" tag below is what tells
# Fabric this cell is the param injection point. DO NOT edit this cell
# in the Fabric editor — Fabric strips the tag on save and breaks the
# web → notebook handoff. Edit only via git.
pipeline_run_id = None
tenant_id = None
triggered_by = "schedule"

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark",
# META   "tags": ["parameters"]
# META }

# CELL ********************

# Adopt a web-triggered queued row if one exists (within last 5 min).
# This is the primary handoff mechanism since Fabric strips the
# parameter cell tag on git-sync. The parameter cell above is kept as a
# secondary path in case Fabric ever fixes parameter passing, but we
# don't depend on it.
if not pipeline_run_id:
    adopted = find_recent_queued_run("mapping_propagate")
    if adopted:
        pipeline_run_id = adopted["id"]
        tenant_id      = adopted.get("tenant_id") or tenant_id
        triggered_by   = adopted.get("triggered_by") or triggered_by
        print(f"adopted recent queued row {pipeline_run_id} (triggered_by={triggered_by})")

run_orchestrator(
    pipeline_kind="mapping_propagate",
    steps=[
        "config_sync",
        "silver_account_xref_build",
        "gold_fact_sale_build",
    ],
    scope="tenant",
    tenant_id=tenant_id,
    triggered_by=triggered_by,
    step_timeout_s=600,
    pipeline_run_id=pipeline_run_id,
)

mssparkutils.notebook.exit("done")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
