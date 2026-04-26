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

# # Pipeline: weekly_full_refresh
#
# Global pipeline (multi-tenant). Identical to incremental_refresh except
# uses `veeva_full_ingest` instead of incremental — pulls every Veeva
# account/call/etc record fresh, catching:
#
#   - Soft-deletes the incremental cursor missed
#   - Late-arriving updates whose modified_date predates last cursor
#   - Schema additions on the Veeva side that incremental wouldn't surface
#   - Anything else that drifts under cursor-based sync
#
# Cadence: weekly Sunday 2am (set in Fabric workspace → Schedule).
# Runs BEFORE delta_maintenance which is scheduled later Sunday morning.
#
# SFTP ingest is omitted here — sales feeds don't have an "incremental
# vs full" distinction the way Veeva does. SFTP rows accumulate via the
# normal incremental pipeline and the snapshot/incremental cadence is
# managed per-feed via tenant_sftp_feed.

# CELL ********************

# MAGIC %run pipeline_config

# CELL ********************

STEPS = [
    "veeva_full_ingest",
    "config_sync",
    "goals_sync",
    "silver_picklist_build",
    "silver_hcp_build",
    "silver_hco_build",
    "silver_user_build",
    "silver_territory_build",
    "silver_account_territory_build",
    "silver_user_territory_build",
    "silver_call_build",
    "silver_sale_build",
    "silver_account_xref_build",
    "gold_dim_date_build",
    "gold_dim_hcp_build",
    "gold_dim_hco_build",
    "gold_dim_user_build",
    "gold_dim_account_build",
    "gold_fact_call_build",
    "gold_fact_sale_build",
]

run_orchestrator(
    pipeline_kind="weekly_full_refresh",
    steps=STEPS,
    scope="global",
    tenant_id=None,
    triggered_by="schedule",
    step_timeout_s=1800,  # 30min — full Veeva ingest is the slow step
)

mssparkutils.notebook.exit("done")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
