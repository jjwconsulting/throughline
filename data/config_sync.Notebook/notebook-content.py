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
# # Postgres -> Fabric config sync
#
# Reads the 7 app-state config tables from Postgres (Supabase) and
# overwrites the matching config.* Delta tables in `throughline_lakehouse`.
#
# Postgres is authoritative — user-edited config lands there via the web
# admin UI. This notebook mirrors it into Fabric so silver/gold notebooks
# and Power BI can read a consistent picture.
#
# Run on demand for now; schedule via a Fabric Data Pipeline once we have
# a real cadence need (nightly should be plenty for config data).
#
# Assumptions:
#   - Attached to `throughline_lakehouse` (schema-enabled).
#   - config.* schema + tables already exist (run 001_config_ddl first).
#   - Fabric Spark has the PostgreSQL JDBC driver available by default.
#
# Secrets handling: this notebook takes PG_USER/PG_PASSWORD as plain
# variables for dev. Per ARCHITECTURE.md §6, these will move to Azure
# Key Vault (retrieved via mssparkutils.credentials.getSecret) before
# we onboard the first real customer.

# %% [parameters]
# Supabase session pooler (port 5432). Example host:
#   aws-1-us-east-1.pooler.supabase.com
# Do not commit real passwords — set these at runtime only.
PG_HOST = "aws-1-us-east-1.pooler.supabase.com"
PG_PORT = 5432
PG_DATABASE = "postgres"
PG_USER = "postgres.zucvjyhnqsjuryqxgqzb"
PG_PASSWORD = "174Jjw14@1549"  # set at runtime; never commit

FABRIC_SCHEMA = "config"

# %%
JDBC_URL = f"jdbc:postgresql://{PG_HOST}:{PG_PORT}/{PG_DATABASE}?sslmode=require"

JDBC_OPTIONS = {
    "url": JDBC_URL,
    "user": PG_USER,
    "password": PG_PASSWORD,
    "driver": "org.postgresql.Driver",
}

# Per-table SELECT queries. UUIDs and enums are cast to text so the JDBC
# driver returns plain strings — avoids PGobject/UUID type issues on Spark's
# side and matches the config.* DDL (which uses STRING for both).
TABLE_QUERIES = {
    "tenant": """
        SELECT id::text AS id, slug, name, status::text AS status, created_at
        FROM public.tenant
    """,
    "tenant_source_field_map": """
        SELECT id::text AS id, tenant_id::text AS tenant_id,
               source_system::text AS source_system,
               silver_table::text AS silver_table,
               silver_column, bronze_source_table, bronze_source_column,
               default_value, transform_sql, updated_by, updated_at
        FROM public.tenant_source_field_map
    """,
    "mapping": """
        SELECT id::text AS id, tenant_id::text AS tenant_id,
               kind::text AS kind,
               source_key, target_value, notes,
               effective_from, effective_to, updated_by, updated_at
        FROM public.mapping
    """,
    "tenant_veeva": """
        SELECT tenant_id::text AS tenant_id,
               vault_domain, username, password_secret_uri, enabled, updated_at
        FROM public.tenant_veeva
    """,
    "tenant_sftp": """
        SELECT tenant_id::text AS tenant_id,
               host, username, key_secret_uri, base_path, enabled, updated_at
        FROM public.tenant_sftp
    """,
    "tenant_email_drop": """
        SELECT id::text AS id, tenant_id::text AS tenant_id,
               feed_name, source_address, subject_pattern, enabled, updated_at
        FROM public.tenant_email_drop
    """,
    "tenant_user": """
        SELECT tenant_id::text AS tenant_id,
               user_email, effective_territory_ids, updated_at
        FROM public.tenant_user
    """,
}

# %%
def sync_table(table_name: str, query: str) -> int:
    """Read one Postgres table and overwrite the matching Fabric config.* table."""
    df = (
        spark.read.format("jdbc")
        .options(**JDBC_OPTIONS)
        .option("query", query.strip())
        .load()
    )
    row_count = df.count()
    (
        df.write.format("delta")
        .mode("overwrite")
        .option("overwriteSchema", "true")
        .saveAsTable(f"{FABRIC_SCHEMA}.{table_name}")
    )
    return row_count

# %%
if not PG_PASSWORD:
    raise ValueError(
        "PG_PASSWORD is empty. Set it in the parameters cell before running."
    )

totals = {}
for table_name, query in TABLE_QUERIES.items():
    print(f"Syncing {table_name}...")
    totals[table_name] = sync_table(table_name, query)
    print(f"  -> {totals[table_name]} rows written to {FABRIC_SCHEMA}.{table_name}")

print("\nSync complete:")
for name, count in totals.items():
    print(f"  {FABRIC_SCHEMA}.{name:<30} {count:>6} rows")


# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
