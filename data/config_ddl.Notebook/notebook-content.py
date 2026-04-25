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

# CELL ********************

# %% [markdown]
# # config DDL — creates the shared `config.*` schema in Fabric
#
# Mirrors `packages/db/src/schema.ts`. Postgres is the authoritative store
# for user-edited config; this notebook creates the matching Delta tables
# that the Postgres → Fabric sync job writes into, and that silver/gold
# notebooks read from.
#
# Assumptions:
#   - Attached to `throughline_lakehouse` (schema-enabled).
#   - Default lakehouse context is set (tables created without 3-part naming).
#
# Idempotent: safe to re-run. Uses CREATE TABLE IF NOT EXISTS.
#
# Type mapping vs Postgres:
#   UUID → STRING, TEXT → STRING, BOOLEAN → BOOLEAN,
#   TIMESTAMPTZ → TIMESTAMP, TEXT[] → ARRAY<STRING>, ENUM → STRING.
#
# Delta does not enforce FKs, uniqueness, or (by default) CHECK constraints.
# Postgres enforces data integrity; this side is a read-only analytical mirror.

# %%
SCHEMA = "config"

spark.sql(f"CREATE SCHEMA IF NOT EXISTS {SCHEMA}")

# %%
# tenant — tenant registry
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {SCHEMA}.tenant (
  id                 STRING    NOT NULL,
  slug               STRING    NOT NULL,
  name               STRING    NOT NULL,
  status             STRING    NOT NULL,
  created_at         TIMESTAMP NOT NULL
) USING DELTA
""")

# %%
# tenant_source_field_map — bronze column → silver column, per tenant + source
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {SCHEMA}.tenant_source_field_map (
  id                   STRING    NOT NULL,
  tenant_id            STRING    NOT NULL,
  source_system        STRING    NOT NULL,
  silver_table         STRING    NOT NULL,
  silver_column        STRING    NOT NULL,
  bronze_source_table  STRING    NOT NULL,
  bronze_source_column STRING,
  default_value        STRING,
  transform_sql        STRING,
  updated_by           STRING    NOT NULL,
  updated_at           TIMESTAMP NOT NULL
) USING DELTA
""")

# %%
# mapping — business-level mappings (product, territory, channel, etc.)
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {SCHEMA}.mapping (
  id              STRING    NOT NULL,
  tenant_id       STRING    NOT NULL,
  kind            STRING    NOT NULL,
  source_key      STRING    NOT NULL,
  target_value    STRING    NOT NULL,
  notes           STRING,
  effective_from  TIMESTAMP NOT NULL,
  effective_to    TIMESTAMP,
  updated_by      STRING    NOT NULL,
  updated_at      TIMESTAMP NOT NULL
) USING DELTA
""")

# %%
# tenant_veeva — per-tenant Veeva Vault integration config (1:1)
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {SCHEMA}.tenant_veeva (
  tenant_id            STRING    NOT NULL,
  vault_domain         STRING    NOT NULL,
  username             STRING    NOT NULL,
  password_secret_uri  STRING    NOT NULL,
  enabled              BOOLEAN   NOT NULL,
  updated_at           TIMESTAMP NOT NULL
) USING DELTA
""")

# %%
# tenant_sftp — per-tenant SFTP integration config (1:1)
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {SCHEMA}.tenant_sftp (
  tenant_id        STRING    NOT NULL,
  host             STRING    NOT NULL,
  username         STRING    NOT NULL,
  key_secret_uri   STRING    NOT NULL,
  base_path        STRING    NOT NULL,
  enabled          BOOLEAN   NOT NULL,
  updated_at       TIMESTAMP NOT NULL
) USING DELTA
""")

# %%
# tenant_sftp_feed — per-feed cadence (full_snapshot vs incremental).
# Drives silver build's batch-selection: snapshot feeds read latest file
# only; incremental feeds accumulate all batches.
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {SCHEMA}.tenant_sftp_feed (
  tenant_id     STRING    NOT NULL,
  feed_name     STRING    NOT NULL,
  feed_type     STRING    NOT NULL,
  silver_table  STRING    NOT NULL,
  notes         STRING,
  enabled       BOOLEAN   NOT NULL,
  updated_by    STRING    NOT NULL,
  updated_at    TIMESTAMP NOT NULL
) USING DELTA
""")

# %%
# tenant_email_drop — per-tenant email ingestion feeds (1:N)
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {SCHEMA}.tenant_email_drop (
  id              STRING    NOT NULL,
  tenant_id       STRING    NOT NULL,
  feed_name       STRING    NOT NULL,
  source_address  STRING    NOT NULL,
  subject_pattern STRING    NOT NULL,
  enabled         BOOLEAN   NOT NULL,
  updated_at      TIMESTAMP NOT NULL
) USING DELTA
""")

# %%
# tenant_user — PBI RLS mapping (user email → tenant + territory scope)
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {SCHEMA}.tenant_user (
  tenant_id              STRING         NOT NULL,
  user_email             STRING         NOT NULL,
  effective_territory_ids ARRAY<STRING>,
  updated_at             TIMESTAMP      NOT NULL
) USING DELTA
""")

# %%
# Verification
tables = spark.sql(f"SHOW TABLES IN {SCHEMA}").collect()
print(f"{SCHEMA}.* has {len(tables)} tables:")
for row in tables:
    print(f"  - {row['tableName']}")


# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
