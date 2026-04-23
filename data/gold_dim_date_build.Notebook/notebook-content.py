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

# # Gold build: dim_date
#
# Generated calendar dimension. One row per day from `START_DATE` to
# `END_DATE`. Tenant-agnostic — same dates apply to all tenants.
#
# `date_key` is YYYYMMDD as INT, suitable for fact table FKs joining on a
# stable integer (faster than date joins, immune to timezone drift).
#
# Includes basic calendar attributes plus US fiscal-year columns. Adjust
# fiscal_year_start_month constant if a tenant uses a non-calendar fiscal year
# (move to per-tenant config when this becomes a real ask).

# CELL ********************

START_DATE = "2020-01-01"
END_DATE   = "2030-12-31"
SILVER_TABLE = None  # purely generated, no source
GOLD_TABLE = "gold.dim_date"

# US default fiscal year starts in January (== calendar year). Override
# per-tenant when needed.
FISCAL_YEAR_START_MONTH = 1

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark",
# META   "tags": ["parameters"]
# META }

# CELL ********************

spark.sql("CREATE SCHEMA IF NOT EXISTS gold")
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {GOLD_TABLE} (
  date_key            INT       NOT NULL,
  date                DATE      NOT NULL,
  year                INT       NOT NULL,
  quarter             INT       NOT NULL,
  month               INT       NOT NULL,
  day                 INT       NOT NULL,
  day_of_week         INT       NOT NULL,
  day_of_year         INT       NOT NULL,
  week_of_year        INT       NOT NULL,
  month_name          STRING    NOT NULL,
  day_name            STRING    NOT NULL,
  is_weekend          BOOLEAN   NOT NULL,
  fiscal_year         INT       NOT NULL,
  fiscal_quarter      INT       NOT NULL,
  year_month          STRING    NOT NULL,
  year_quarter        STRING    NOT NULL,
  gold_built_at       TIMESTAMP NOT NULL
) USING DELTA
""")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Generate using sequence + explode — fast, no loops
gen_sql = f"""
WITH dates AS (
  SELECT explode(sequence(to_date('{START_DATE}'), to_date('{END_DATE}'), interval 1 day)) AS date
)
SELECT
  CAST(date_format(date, 'yyyyMMdd') AS INT) AS date_key,
  date,
  year(date)                    AS year,
  quarter(date)                 AS quarter,
  month(date)                   AS month,
  day(date)                     AS day,
  dayofweek(date)               AS day_of_week,
  dayofyear(date)               AS day_of_year,
  weekofyear(date)              AS week_of_year,
  date_format(date, 'MMMM')     AS month_name,
  date_format(date, 'EEEE')     AS day_name,
  dayofweek(date) IN (1, 7)     AS is_weekend,
  CASE
    WHEN month(date) >= {FISCAL_YEAR_START_MONTH} THEN year(date)
    ELSE year(date) - 1
  END AS fiscal_year,
  CASE
    WHEN ((month(date) - {FISCAL_YEAR_START_MONTH} + 12) % 12) < 3 THEN 1
    WHEN ((month(date) - {FISCAL_YEAR_START_MONTH} + 12) % 12) < 6 THEN 2
    WHEN ((month(date) - {FISCAL_YEAR_START_MONTH} + 12) % 12) < 9 THEN 3
    ELSE 4
  END AS fiscal_quarter,
  date_format(date, 'yyyy-MM') AS year_month,
  CONCAT(year(date), '-Q', quarter(date)) AS year_quarter,
  current_timestamp() AS gold_built_at
FROM dates
"""

result = spark.sql(gen_sql)
row_count = result.count()

(
    result.write
    .format("delta")
    .mode("overwrite")
    .option("overwriteSchema", "true")
    .saveAsTable(GOLD_TABLE)
)
print(f"Wrote {row_count:,} rows to {GOLD_TABLE} ({START_DATE} to {END_DATE})")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

print("=== Sample year (2026) ===")
spark.sql(f"""
  SELECT date_key, date, day_name, fiscal_year, fiscal_quarter, year_quarter, is_weekend
  FROM {GOLD_TABLE}
  WHERE year = 2026 AND month IN (1, 4, 7, 10) AND day = 1
  ORDER BY date
""").show(truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
