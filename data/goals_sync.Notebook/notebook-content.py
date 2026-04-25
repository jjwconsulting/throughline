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
# # Postgres -> Fabric goals sync
#
# Reads `public.goal` from Postgres (Supabase) and overwrites `gold.fact_goal`
# in `throughline_lakehouse`.
#
# **Important — this is a downstream ANALYTICS mirror, not the read path
# for the web app.** Goals live canonically in Postgres because admins edit
# them interactively (/admin/goals form, CSV upload, recommendation
# accept) and need to see their saves reflected immediately on the
# dashboard / inbox. The web app reads goals from Postgres directly to
# avoid sync lag.
#
# `gold.fact_goal` exists for:
#   - PBI native DAX measures (goal vs actual cross-tabs)
#   - Future SQL-side sales-vs-goal queries that JOIN to fact_sales
#   - Scheduled analytics that need goals + facts in one query plan
#
# Pattern mirrors `config_sync.Notebook` — same JDBC reader, same overwrite
# semantics. Run on demand after admin work, OR schedule nightly via a
# Fabric Data Pipeline. Lag from save → mirror is acceptable here because
# nothing time-critical reads from this table.
#
# Adds a few convenience columns vs the source table:
#   - year, quarter, month, year_quarter — extracted from period_start,
#     useful for GROUP BY in reporting without re-parsing dates
#   - period_days — total days in the goal's period, used by attainment
#     pro-ration formulas
#
# Secrets: PG_USER/PG_PASSWORD as plain variables for dev. Per
# ARCHITECTURE.md §6, these move to Azure Key Vault before the first real
# customer.

# %% [parameters]
PG_HOST = "aws-1-us-east-1.pooler.supabase.com"
PG_PORT = 5432
PG_DATABASE = "postgres"
PG_USER = "postgres.zucvjyhnqsjuryqxgqzb"
PG_PASSWORD = "174Jjw14@1549"  # set at runtime; never commit

GOLD_TABLE = "gold.fact_goal"

# %%
JDBC_URL = f"jdbc:postgresql://{PG_HOST}:{PG_PORT}/{PG_DATABASE}?sslmode=require"
JDBC_OPTIONS = {
    "url": JDBC_URL,
    "user": PG_USER,
    "password": PG_PASSWORD,
    "driver": "org.postgresql.Driver",
}

# Source query — UUIDs and enums cast to text for clean Spark types. Numeric
# goal_value cast to DOUBLE for analytics compatibility (we accept the small
# precision loss vs Postgres's NUMERIC(18,4) — goal values are rarely below
# the cent-fraction grain that matters).
SOURCE_QUERY = """
SELECT
  id::text                  AS goal_id,
  tenant_id::text           AS tenant_id,
  metric::text              AS metric,
  entity_type::text         AS entity_type,
  entity_id,
  period_type::text         AS period_type,
  period_start,
  period_end,
  goal_value::double precision AS goal_value,
  goal_unit,
  source::text              AS source,
  created_by,
  created_at,
  updated_at
FROM public.goal
"""

# %%
spark.sql("CREATE SCHEMA IF NOT EXISTS gold")
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {GOLD_TABLE} (
  goal_id         STRING    NOT NULL,
  tenant_id       STRING    NOT NULL,
  metric          STRING    NOT NULL,
  entity_type     STRING    NOT NULL,
  entity_id       STRING,                -- NULL only for entity_type='tenant_wide'
  period_type     STRING    NOT NULL,
  period_start    DATE      NOT NULL,
  period_end      DATE      NOT NULL,
  goal_value      DOUBLE    NOT NULL,
  goal_unit       STRING    NOT NULL,
  source          STRING    NOT NULL,
  -- Derived attributes (extracted from period_start; saves re-parsing in
  -- every report query)
  year            INT       NOT NULL,
  quarter         INT       NOT NULL,
  month           INT       NOT NULL,
  year_quarter    STRING    NOT NULL,    -- "2026-Q3"
  year_month      STRING    NOT NULL,    -- "2026-07"
  period_days     INT       NOT NULL,    -- inclusive day count
  created_by      STRING,
  created_at      TIMESTAMP,
  updated_at      TIMESTAMP,
  gold_built_at   TIMESTAMP NOT NULL
) USING DELTA
""")

# %%
from pyspark.sql import functions as F

raw = (
    spark.read.format("jdbc")
    .options(**JDBC_OPTIONS)
    .option("query", SOURCE_QUERY.strip())
    .load()
)

result = (
    raw
    .withColumn("year", F.year("period_start"))
    .withColumn("quarter", F.quarter("period_start"))
    .withColumn("month", F.month("period_start"))
    .withColumn(
        "year_quarter",
        F.concat(F.year("period_start"), F.lit("-Q"), F.quarter("period_start")),
    )
    .withColumn("year_month", F.date_format("period_start", "yyyy-MM"))
    .withColumn(
        "period_days",
        (F.datediff("period_end", "period_start") + 1).cast("int"),
    )
    .withColumn("gold_built_at", F.current_timestamp())
    .select(
        "goal_id",
        "tenant_id",
        "metric",
        "entity_type",
        "entity_id",
        "period_type",
        "period_start",
        "period_end",
        "goal_value",
        "goal_unit",
        "source",
        "year",
        "quarter",
        "month",
        "year_quarter",
        "year_month",
        "period_days",
        "created_by",
        "created_at",
        "updated_at",
        "gold_built_at",
    )
)

row_count = result.count()
(
    result.write.format("delta")
    .mode("overwrite")
    .option("overwriteSchema", "true")
    .saveAsTable(GOLD_TABLE)
)
print(f"Wrote {row_count:,} rows to {GOLD_TABLE}")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Verification

print("=== Goals by tenant + metric + period_type ===")
spark.sql(f"""
  SELECT tenant_id, metric, period_type, COUNT(*) AS goals,
         SUM(goal_value) AS total_value
  FROM {GOLD_TABLE}
  GROUP BY tenant_id, metric, period_type
  ORDER BY tenant_id, metric, period_type
""").show(truncate=False)

print("=== Goals overlapping today (active period) ===")
spark.sql(f"""
  SELECT entity_type, COUNT(*) AS active_goals,
         MIN(period_start) AS earliest_start,
         MAX(period_end) AS latest_end
  FROM {GOLD_TABLE}
  WHERE period_start <= CURRENT_DATE() AND period_end >= CURRENT_DATE()
  GROUP BY entity_type
""").show(truncate=False)

print("=== Sample 5 rep-level goals ===")
spark.sql(f"""
  SELECT entity_id, year_quarter, goal_value, source, updated_at
  FROM {GOLD_TABLE}
  WHERE entity_type = 'rep'
  ORDER BY updated_at DESC
  LIMIT 5
""").show(truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
