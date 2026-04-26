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

# # Pipeline: incremental_refresh
#
# Global pipeline (multi-tenant). The everyday refresh that keeps gold
# tables fresh against incremental source updates:
#
#   - Veeva incremental ingest  (cursor-tracked, ~15-min batches)
#   - SFTP ingest               (picks up any new files in tenant drop dirs)
#   - Postgres → Fabric mirrors (config_sync, goals_sync)
#   - Silver builds             (all entities, including account_xref)
#   - Gold builds               (dims + facts)
#
# Cadence:
#   - Dev:   daily 2am   (set in Fabric workspace → Schedule)
#   - Prod:  every 30-60 min during business hours
#
# Triggered by: Fabric scheduler (default), or admin via REST trigger.
# NOT customer-triggerable — global ops surface, not on /admin/pipelines.
#
# Failure: first step that fails halts the chain. step_metrics records
# what completed before the error; pipeline_run.error has the full
# traceback for the health page.

# CELL ********************

# MAGIC %run pipeline_config

# CELL ********************

STEPS = [
    # 1. Source ingest — independent, could parallelize but keeping serial
    #    for predictable retry semantics.
    "veeva_incremental_ingest",
    "sftp_ingest",

    # 2. Postgres → Fabric config mirrors (cheap; required before silver
    #    rebuilds that depend on tenant_source_field_map / mapping).
    "config_sync",
    "goals_sync",

    # 3. Silver — picklist first (others reference it for label translation).
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

    # 4. Gold — dims first, facts second (facts FK to dims).
    "gold_dim_date_build",
    "gold_dim_hcp_build",
    "gold_dim_hco_build",
    "gold_dim_user_build",
    "gold_dim_account_build",
    "gold_fact_call_build",
    "gold_fact_sale_build",
]

run_orchestrator(
    pipeline_kind="incremental_refresh",
    steps=STEPS,
    scope="global",
    tenant_id=None,
    triggered_by="schedule",
    step_timeout_s=900,  # 15min per step — silver builds can be slow on full sweep
)

mssparkutils.notebook.exit("done")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
