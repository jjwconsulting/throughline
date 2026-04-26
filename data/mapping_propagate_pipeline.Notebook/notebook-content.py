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
# Orchestrator. Runs the three notebooks needed to propagate Postgres
# `mapping` table changes (account_xref) into `gold.fact_sale.account_key`
# so dashboard sales attribution refreshes:
#
#   1. config_sync                — mirrors Postgres mapping rows into
#                                   Fabric config.mapping
#   2. silver_account_xref_build  — joins config + bronze CSV imports into
#                                   silver.account_xref (UI wins on conflict)
#   3. gold_fact_sale_build       — re-joins silver.sale to silver.account_xref
#                                   to dim_hcp/dim_hco; populates account_key
#
# Triggered by:
#   - The "Run pipeline" button on /admin/mappings (web app fires the
#     Fabric REST API). End-user / admin path.
#   - Scheduled run (configure in Fabric: workspace settings → schedule).
#     Recommended: every few hours OR nightly.
#   - Manual: open this notebook + click Run.
#
# Failure handling: each step's exception bubbles up so the run fails
# loudly. Caller (REST API client / Fabric run history) shows the failure.

# CELL ********************

import time

steps = [
    "config_sync",
    "silver_account_xref_build",
    "gold_fact_sale_build",
]

# Per-step timeout in seconds. Each notebook runs the full silver/gold
# transform — should complete in well under 5 minutes for any tenant
# we'd reasonably support. Bump if a tenant ever exceeds this.
STEP_TIMEOUT_SECONDS = 600

run_started_at = time.time()
print(f"=== mapping_propagate_pipeline started ===")

for step in steps:
    print(f"\n→ Running {step}...")
    step_start = time.time()
    # mssparkutils.notebook.run resolves notebooks by displayName within
    # the same workspace. Returns the notebook's `mssparkutils.notebook.exit()`
    # value (or raises if the run fails / times out).
    result = mssparkutils.notebook.run(step, STEP_TIMEOUT_SECONDS)
    step_elapsed = time.time() - step_start
    print(f"✓ {step} completed in {step_elapsed:.1f}s. Result: {result}")

total_elapsed = time.time() - run_started_at
print(f"\n=== mapping_propagate_pipeline finished in {total_elapsed:.1f}s ===")

# Exit value goes back to the caller (web REST API consumer) as a string.
mssparkutils.notebook.exit(f"OK in {total_elapsed:.1f}s across {len(steps)} steps")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
