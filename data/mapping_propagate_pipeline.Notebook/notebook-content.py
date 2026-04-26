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
#
# Tenant-scoped pipeline. Triggered by the "Run sync now" button on
# /admin/mappings (web app) — admin saves mappings, clicks the button,
# this notebook propagates them through:
#
#   1. config_sync                — Postgres mapping rows → Fabric
#                                   config.mapping
#   2. silver_account_xref_build  — Bronze CSV + Postgres mappings →
#                                   silver.account_xref (UI wins)
#   3. gold_fact_sale_build       — silver.sale × silver.account_xref ×
#                                   dim_hcp/dim_hco → gold.fact_sale
#                                   (account_key populated)
#
# Note: the underlying child notebooks process ALL tenants in a single
# run (config_sync mirrors all tenant mapping rows, etc.). The "tenant"
# scope here is about WHO TRIGGERED the run for accountability +
# /admin/pipelines display, not about a per-tenant subset of work.
#
# Web flow (parameters passed in via Fabric REST API):
#   pipeline_run_id — the UUID the web action just inserted in
#                     pipeline_run with status='queued'. Notebook updates
#                     this same row instead of double-inserting.
#   tenant_id       — the tenant whose admin clicked the button.
#   triggered_by    — 'admin' | 'bypass'. Identifies role on the audit row.
#
# Schedule flow: parameters are not supplied (left as defaults). Notebook
# inserts its own pipeline_run row. mapping_propagate isn't currently
# scheduled — the daily incremental_refresh re-runs these same steps as
# part of the broader chain — but the pattern supports either trigger.

# CELL ********************

# MAGIC %run pipeline_config

# CELL ********************

# Parameter cell — values here are overridable by the Fabric REST API
# trigger via executionData.parameters. Defaults apply when notebook
# runs standalone (manual or scheduled).
pipeline_run_id: str | None = None
tenant_id: str | None = None
triggered_by: str = "schedule"

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark",
# META   "tags": ["parameters"]
# META }

# CELL ********************

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
