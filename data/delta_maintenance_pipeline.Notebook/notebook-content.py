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
#
#   - OPTIMIZE              compacts small files into larger ones.
#                           Without this, repeated incremental writes
#                           leave thousands of small parquet files that
#                           tank query performance.
#   - VACUUM RETAIN 168     removes old file versions older than 7 days
#                           (168 hours). Frees storage.
#
# Cadence: weekly Sunday ~4am, AFTER weekly_full_refresh completes.
#
# This notebook orchestrates ITSELF (no child notebooks) — runs OPTIMIZE
# and VACUUM directly via Spark SQL on each table. Doesn't use
# `run_orchestrator` since the unit of work is a table-level command, not
# a child notebook. Records its own pipeline_run row manually.

# CELL ********************

# MAGIC %run pipeline_config

# CELL ********************

# Tables to maintain. Order doesn't matter — each is independent. Add
# new gold/silver tables here when they're created.
TABLES = [
    # Bronze is huge but rebuilt frequently from source — usually skipped.
    # Add specific bronze tables here if their query patterns warrant it.
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

# How many hours of file history to keep on VACUUM. 168 = 7 days, leaves
# room for time-travel debugging within a week. Default is 720 (30 days);
# we shorten it because we don't need long version history in dev.
VACUUM_RETAIN_HOURS = 168

# CELL ********************

import time
from datetime import datetime, timezone

run_id = record_pipeline_run_start(
    kind="delta_maintenance",
    scope="global",
    tenant_id=None,
    triggered_by="schedule",
)

step_metrics: dict[str, dict] = {}
overall_start = time.time()
failed_table = None
error_text = None

for table in TABLES:
    metric: dict = {"status": "ok"}
    table_start = time.time()
    try:
        # Skip tables that don't exist yet (e.g. fact_goal in fresh tenants).
        if not spark.catalog.tableExists(table):
            metric["status"] = "skipped"
            metric["reason"] = "table_not_found"
            step_metrics[table] = metric
            print(f"~ {table}: skipped (not found)")
            continue

        # OPTIMIZE — compact small files. Returns a row with metrics that
        # we capture for visibility on the health page.
        opt_result = spark.sql(f"OPTIMIZE {table}").collect()
        if opt_result:
            row = opt_result[0].asDict()
            metric["optimize"] = {
                "files_added":   row.get("metrics", {}).get("numFilesAdded") if "metrics" in row else None,
                "files_removed": row.get("metrics", {}).get("numFilesRemoved") if "metrics" in row else None,
            }

        # VACUUM — delete old file versions. Spark prints removed-file
        # counts to stdout; we don't parse them, just record duration.
        spark.sql(
            f"VACUUM {table} RETAIN {VACUUM_RETAIN_HOURS} HOURS"
        ).collect()

        metric["duration_s"] = round(time.time() - table_start, 1)
        step_metrics[table] = metric
        print(f"✓ {table}: OPTIMIZE+VACUUM in {metric['duration_s']}s")
    except Exception as exc:
        # Single-table failure shouldn't kill the whole maintenance pass —
        # other tables can still benefit. Record the failure and continue.
        # Overall pipeline status flips to 'failed' if ANY table errors.
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
        run_id, "failed",
        step_metrics=step_metrics,
        error=error_text,
        message=summary,
    )
else:
    record_pipeline_run_finish(
        run_id, "succeeded",
        step_metrics=step_metrics,
        message=summary,
    )

print(f"\n=== delta_maintenance finished — {summary} ===")
mssparkutils.notebook.exit(summary)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
