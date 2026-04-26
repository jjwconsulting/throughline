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

# # pipeline_config
#
# Shared configuration + helper functions for pipeline orchestrator
# notebooks. Each orchestrator imports the contents of this notebook via
# `mssparkutils.notebook.run("pipeline_config")` is NOT useful here (it
# returns the exit value, not function refs) — so we use Fabric's `%run`
# magic instead. Each orchestrator's first cell is:
#
#     %run pipeline_config
#
# After which `record_pipeline_run_start`, `record_pipeline_run_finish`,
# and `run_step` are in scope.
#
# Why writeback uses Supabase REST API (not JDBC):
#   - No JDBC driver dependency
#   - Service-role key bypasses RLS so notebooks can write tenant-tagged
#     pipeline_run rows directly
#   - Same pattern propgolf uses; battle-tested at scale
#
# Secret handling — the service-role key is NOT in git. It lives in the
# lakehouse Files folder (which is excluded from git-sync). To set up a
# new workspace:
#   1. Fabric workspace → throughline_lakehouse → Files → New folder
#      "secrets" → upload pipeline_config.json with shape:
#        { "supabase_service_role_key": "sb_secret_..." }
#   2. To rotate: Supabase → Settings → API Keys → generate new key,
#      re-upload pipeline_config.json with the new value. No git change.

# CELL ********************

import json
import time
import traceback
from datetime import datetime, timezone

import requests

# ---- Supabase target -------------------------------------------------------
# URL is safe to commit; service-role key is loaded from the lakehouse
# Files folder at runtime (Files/ is excluded from git-sync, so the key
# never enters the repo).
SUPABASE_URL       = "https://zucvjyhnqsjuryqxgqzb.supabase.co"
PIPELINE_RUN_TABLE = "pipeline_run"

_secrets_path = "Files/secrets/pipeline_config.json"
_secrets = json.loads(mssparkutils.fs.head(_secrets_path, 8192))
SUPABASE_SERVICE_ROLE_KEY = _secrets["supabase_service_role_key"]

_SUPABASE_HEADERS = {
    "apikey":        SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
    "Content-Type":  "application/json",
    # Prefer header so POST returns the inserted row (including the
    # generated UUID id we need for the finish-update PATCH).
    "Prefer":        "return=representation",
}

# ---- Pipeline run lifecycle -----------------------------------------------

def record_pipeline_run_start(
    kind: str,
    scope: str = "global",
    tenant_id: str | None = None,
    triggered_by: str = "schedule",
) -> str | None:
    """
    Insert a pipeline_run row with status='running'. Returns the row UUID
    so the orchestrator can update it on finish. Returns None on writeback
    failure — orchestrator continues regardless (don't block real work on
    observability).

    kind          — one of pipeline_kind enum values (mapping_propagate,
                    incremental_refresh, weekly_full_refresh, delta_maintenance)
    scope         — 'global' for ops pipelines, 'tenant' for tenant-scoped
    tenant_id     — required when scope='tenant'; null for global
    triggered_by  — 'schedule' for Fabric scheduled runs, 'admin' for web
                    triggers, 'system' for action-triggered (onboarding, etc.)
    """
    payload = {
        "kind":         kind,
        "scope":        scope,
        "tenant_id":    tenant_id,
        "status":       "running",
        "triggered_by": triggered_by,
    }
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/{PIPELINE_RUN_TABLE}",
            headers=_SUPABASE_HEADERS,
            json=payload,
            timeout=30,
        )
        resp.raise_for_status()
        row = resp.json()[0]
        return row["id"]
    except Exception as exc:
        print(f"⚠ pipeline_run start writeback failed: {exc}")
        return None


def record_pipeline_run_finish(
    run_id: str | None,
    status: str,
    step_metrics: dict | None = None,
    error: str | None = None,
    message: str | None = None,
) -> None:
    """
    Update a pipeline_run row with finish state. status ∈ {succeeded,
    failed}. step_metrics is JSON-serialized to a text column (we kept
    the column as text rather than jsonb for simpler migrations; readers
    JSON.parse on the way out).

    Silent no-op when run_id is None (start writeback failed earlier).
    """
    if not run_id:
        return
    payload = {
        "status":       status,
        "finished_at":  datetime.now(timezone.utc).isoformat(),
        "step_metrics": json.dumps(step_metrics) if step_metrics else None,
        "error":        error,
        "message":      message,
    }
    try:
        resp = requests.patch(
            f"{SUPABASE_URL}/rest/v1/{PIPELINE_RUN_TABLE}?id=eq.{run_id}",
            headers=_SUPABASE_HEADERS,
            json=payload,
            timeout=30,
        )
        resp.raise_for_status()
    except Exception as exc:
        print(f"⚠ pipeline_run finish writeback failed: {exc}")


# ---- Step runner -----------------------------------------------------------

def run_step(step_name: str, timeout_s: int = 600) -> dict:
    """
    Runs a child notebook by display name and returns a metrics dict
    suitable for inclusion in step_metrics. Re-raises on failure so the
    orchestrator can record the error + bail.

    Returns:
        { "status": "ok", "duration_s": 12.3, "exit_value": "..." }
    """
    start = time.time()
    try:
        exit_value = mssparkutils.notebook.run(step_name, timeout_s)
        duration = time.time() - start
        print(f"✓ {step_name} OK in {duration:.1f}s — {exit_value}")
        return {
            "status":     "ok",
            "duration_s": round(duration, 1),
            "exit_value": str(exit_value),
        }
    except Exception as exc:
        duration = time.time() - start
        print(f"✗ {step_name} FAILED after {duration:.1f}s — {exc}")
        # Re-raise after recording so orchestrator catches it and writes
        # the failure metric.
        exc._step_metrics = {
            "status":     "error",
            "duration_s": round(duration, 1),
            "error":      str(exc),
        }
        raise


def _update_pipeline_run_status(run_id: str, status: str) -> None:
    """In-flight status flip (e.g. queued → running). Same pattern as
    finish but doesn't set finished_at."""
    if not run_id:
        return
    try:
        resp = requests.patch(
            f"{SUPABASE_URL}/rest/v1/{PIPELINE_RUN_TABLE}?id=eq.{run_id}",
            headers=_SUPABASE_HEADERS,
            json={"status": status},
            timeout=30,
        )
        resp.raise_for_status()
    except Exception as exc:
        print(f"⚠ pipeline_run status update failed: {exc}")


def run_orchestrator(
    pipeline_kind: str,
    steps: list[str],
    scope: str = "global",
    tenant_id: str | None = None,
    triggered_by: str = "schedule",
    step_timeout_s: int = 600,
    pipeline_run_id: str | None = None,
) -> str:
    """
    Standard orchestrator: records start, runs each step in sequence,
    records finish (or failure on first error). Returns a short summary
    string suitable for `mssparkutils.notebook.exit()`.

    Two trigger paths:
      1. Standalone (Fabric scheduler / manual notebook run):
         pipeline_run_id is None — orchestrator inserts a fresh row.
      2. Web-triggered (e.g. /admin/mappings "Run sync now"):
         pipeline_run_id is the UUID the web action just inserted (with
         status='queued'). Orchestrator flips it to 'running' on start,
         then updates with finish state. Avoids duplicate rows.

    All orchestrators should call this rather than hand-rolling the run
    loop, so behavior + writeback stay consistent.
    """
    print(f"=== {pipeline_kind} ({scope}) started ===")
    pipeline_start = time.time()
    if pipeline_run_id:
        run_id = pipeline_run_id
        _update_pipeline_run_status(run_id, "running")
        print(f"using web-supplied pipeline_run_id: {run_id}")
    else:
        run_id = record_pipeline_run_start(
            kind=pipeline_kind,
            scope=scope,
            tenant_id=tenant_id,
            triggered_by=triggered_by,
        )

    step_metrics: dict[str, dict] = {}
    try:
        for step in steps:
            print(f"\n→ Running {step}...")
            step_metrics[step] = run_step(step, step_timeout_s)
        elapsed = time.time() - pipeline_start
        message = f"OK in {elapsed:.1f}s across {len(steps)} steps"
        print(f"\n=== {pipeline_kind} finished — {message} ===")
        record_pipeline_run_finish(
            run_id, "succeeded", step_metrics=step_metrics, message=message,
        )
        return message
    except Exception as exc:
        # Capture the step-specific metric we attached in run_step
        if hasattr(exc, "_step_metrics"):
            failed_step = next(
                (s for s in steps if s not in step_metrics), "unknown",
            )
            step_metrics[failed_step] = exc._step_metrics
        elapsed = time.time() - pipeline_start
        error_text = f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}"
        message = f"FAILED after {elapsed:.1f}s"
        print(f"\n=== {pipeline_kind} {message} ===")
        record_pipeline_run_finish(
            run_id, "failed",
            step_metrics=step_metrics, error=error_text, message=message,
        )
        raise


print("pipeline_config loaded — record_pipeline_run_start / _finish / run_orchestrator available")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
