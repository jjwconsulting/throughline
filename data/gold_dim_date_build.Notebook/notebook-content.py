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
# Includes basic calendar attributes, US fiscal-year columns, US federal
# holiday data, and `today()`-relative columns. The relative columns
# (`relative_day`, `relative_quarter`, `is_business_day` etc.) are
# pre-computed so Direct Lake doesn't fall back to DirectQuery on filters
# like "current quarter" or "last 13 weeks" — must run **daily** to stay
# current.
#
# Adjust `FISCAL_YEAR_START_MONTH` if a tenant uses a non-calendar fiscal
# year (move to per-tenant config when this becomes a real ask).

# CELL ********************

import datetime as dt
from pyspark.sql import functions as F
from pyspark.sql.window import Window

START_DATE = "2020-01-01"
END_DATE   = "2030-12-31"
GOLD_TABLE = "gold.dim_date"

# US default fiscal year starts in January (== calendar year). Override
# per-tenant when needed.
FISCAL_YEAR_START_MONTH = 1

# US federal holiday range — must cover [START_DATE, END_DATE].
HOLIDAY_START_YEAR = 2020
HOLIDAY_END_YEAR   = 2030

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark",
# META   "tags": ["parameters"]
# META }

# CELL ********************

# DDL — full column list. We rewrite the whole table on every run so the
# overwriteSchema option below picks up new columns automatically.

spark.sql("CREATE SCHEMA IF NOT EXISTS gold")
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {GOLD_TABLE} (
  date_key                 INT       NOT NULL,
  date                     DATE      NOT NULL,
  year                     INT       NOT NULL,
  quarter                  INT       NOT NULL,
  month                    INT       NOT NULL,
  day                      INT       NOT NULL,
  day_of_week              INT       NOT NULL,
  day_of_year              INT       NOT NULL,
  week_of_year             INT       NOT NULL,
  month_name               STRING    NOT NULL,
  day_name                 STRING    NOT NULL,
  is_weekend               BOOLEAN   NOT NULL,
  fiscal_year              INT       NOT NULL,
  fiscal_quarter           INT       NOT NULL,
  year_month               STRING    NOT NULL,
  year_quarter             STRING    NOT NULL,
  -- Period boundaries (useful for "first day of quarter" filters)
  first_day_of_month       DATE      NOT NULL,
  last_day_of_month        DATE      NOT NULL,
  first_day_of_quarter     DATE      NOT NULL,
  last_day_of_quarter      DATE      NOT NULL,
  start_of_week            DATE      NOT NULL,    -- Monday of this date's week
  -- Period-position counters
  day_of_quarter           INT       NOT NULL,
  week_of_month            INT       NOT NULL,
  week_of_quarter          INT       NOT NULL,
  month_of_quarter         INT       NOT NULL,
  -- US federal holiday data
  is_business_day          BOOLEAN   NOT NULL,    -- weekday AND not a US federal holiday
  is_holiday               BOOLEAN   NOT NULL,
  holiday_usa              STRING,                -- name of the holiday, NULL on non-holidays
  -- TODAY()-relative columns (recomputed on every run; rerun daily)
  relative_day             INT       NOT NULL,    -- days from today (negative = past)
  relative_week            INT       NOT NULL,
  relative_month           INT       NOT NULL,
  relative_quarter         INT       NOT NULL,
  relative_business_day    INT,                   -- NULL on non-business days
  start_of_current_week    DATE      NOT NULL,    -- constant column: Monday of TODAY's week
  -- Index columns useful for "latest N months" filters
  month_index              INT       NOT NULL,    -- dense rank descending by year_month (latest = 1)
  gold_built_at            TIMESTAMP NOT NULL
) USING DELTA
""")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# 1. Generate date spine

dim = (
    spark.sql(
        f"SELECT sequence(DATE '{START_DATE}', DATE '{END_DATE}', INTERVAL 1 DAY) AS dates"
    )
    .select(F.explode("dates").alias("date"))
)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# 2. Static calendar attributes

dim = (
    dim
    .withColumn("date_key",      (F.year("date") * 10000 + F.month("date") * 100 + F.dayofmonth("date")).cast("int"))
    .withColumn("year",          F.year("date"))
    .withColumn("quarter",       F.quarter("date"))
    .withColumn("month",         F.month("date"))
    .withColumn("day",           F.dayofmonth("date"))
    .withColumn("day_of_week",   F.dayofweek("date"))            # 1=Sun .. 7=Sat (Spark default)
    .withColumn("day_of_year",   F.dayofyear("date"))
    .withColumn("week_of_year",  F.weekofyear("date"))
    .withColumn("month_name",    F.date_format("date", "MMMM"))
    .withColumn("day_name",      F.date_format("date", "EEEE"))
    .withColumn("is_weekend",    F.dayofweek("date").isin(1, 7))
    # Fiscal year/quarter
    .withColumn("fiscal_year",
        F.when(F.month("date") >= FISCAL_YEAR_START_MONTH, F.year("date"))
         .otherwise(F.year("date") - 1))
    .withColumn(
        "fiscal_quarter",
        F.when(((F.month("date") - FISCAL_YEAR_START_MONTH + 12) % 12) < 3, F.lit(1))
         .when(((F.month("date") - FISCAL_YEAR_START_MONTH + 12) % 12) < 6, F.lit(2))
         .when(((F.month("date") - FISCAL_YEAR_START_MONTH + 12) % 12) < 9, F.lit(3))
         .otherwise(F.lit(4))
    )
    .withColumn("year_month",    F.date_format("date", "yyyy-MM"))
    .withColumn("year_quarter",  F.concat(F.year("date"), F.lit("-Q"), F.quarter("date")))
    # Period boundaries
    .withColumn("first_day_of_month", F.trunc("date", "MM"))
    .withColumn("last_day_of_month",  F.last_day("date"))
    # Monday of this date's week (DATEFIRST-independent: 1900-01-01 was a Monday)
    .withColumn(
        "start_of_week",
        F.date_sub("date", (F.datediff("date", F.lit("1900-01-01")) % 7).cast("int"))
    )
)

# Quarter boundaries
_q_start_month = (F.quarter("date") - 1) * 3 + 1
dim = (
    dim
    .withColumn(
        "first_day_of_quarter",
        F.to_date(F.concat_ws("-",
            F.year("date").cast("string"),
            F.lpad(_q_start_month.cast("string"), 2, "0"),
            F.lit("01")), "yyyy-MM-dd")
    )
    .withColumn(
        "last_day_of_quarter",
        F.add_months("first_day_of_quarter", 3) - F.expr("INTERVAL 1 DAY")
    )
)

# Period-position counters
dim = (
    dim
    .withColumn("day_of_quarter",   (F.datediff("date", "first_day_of_quarter") + 1).cast("int"))
    .withColumn("week_of_month",    F.ceil(F.col("day") / F.lit(7)).cast("int"))
    .withColumn("week_of_quarter",  F.ceil(F.col("day_of_quarter") / F.lit(7)).cast("int"))
    .withColumn("month_of_quarter", ((F.col("month") - 1) % 3 + 1).cast("int"))
)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# 3. US federal holiday data
# Hardcoded — bumps required when HOLIDAY_END_YEAR is reached.

def _nth_weekday(year, month, n, weekday):
    """N-th occurrence (1-based) of weekday (0=Mon) in month/year."""
    d = dt.date(year, month, 1)
    offset = (weekday - d.weekday()) % 7
    return d + dt.timedelta(days=offset + (n - 1) * 7)

def _last_weekday(year, month, weekday):
    """Last occurrence of weekday (0=Mon) in month/year."""
    if month == 12:
        last = dt.date(year + 1, 1, 1) - dt.timedelta(days=1)
    else:
        last = dt.date(year, month + 1, 1) - dt.timedelta(days=1)
    offset = (last.weekday() - weekday) % 7
    return last - dt.timedelta(days=offset)

def _observed(d):
    """Saturday → observe Friday; Sunday → observe Monday."""
    wd = d.weekday()
    if wd == 5:  return d - dt.timedelta(days=1)
    if wd == 6:  return d + dt.timedelta(days=1)
    return d

_holiday_rows = []
for _yr in range(HOLIDAY_START_YEAR, HOLIDAY_END_YEAR + 1):
    _raw = [
        (_observed(dt.date(_yr, 1, 1)),       "New Year's Day"),
        (_nth_weekday(_yr, 1, 3, 0),          "Martin Luther King Jr. Day"),
        (_nth_weekday(_yr, 2, 3, 0),          "Presidents' Day"),
        (_last_weekday(_yr, 5, 0),            "Memorial Day"),
        (_observed(dt.date(_yr, 7, 4)),       "Independence Day"),
        (_nth_weekday(_yr, 9, 1, 0),          "Labor Day"),
        (_nth_weekday(_yr, 10, 2, 0),         "Columbus Day"),
        (_observed(dt.date(_yr, 11, 11)),     "Veterans Day"),
        (_nth_weekday(_yr, 11, 4, 3),         "Thanksgiving Day"),
        (_observed(dt.date(_yr, 12, 25)),     "Christmas Day"),
    ]
    if _yr >= 2021:
        _raw.append((_observed(dt.date(_yr, 6, 19)), "Juneteenth"))
    for _hdate, _hname in _raw:
        _holiday_rows.append((_hdate.isoformat(), _hname))

_holiday_df = (
    spark.createDataFrame(_holiday_rows, schema="holiday_date STRING, holiday_usa STRING")
    .withColumn("date", F.to_date("holiday_date", "yyyy-MM-dd"))
    .drop("holiday_date")
)

dim = (
    dim
    .join(_holiday_df, on="date", how="left")
    .withColumn("is_holiday", F.col("holiday_usa").isNotNull())
    .withColumn("is_business_day", (~F.col("is_weekend")) & F.col("holiday_usa").isNull())
)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# 4. TODAY()-relative columns (must rerun this notebook daily)

today         = F.current_date()
today_year    = F.year(today)
today_month   = F.month(today)
today_quarter = F.quarter(today)

dim = (
    dim
    .withColumn("relative_day", F.datediff("date", today).cast("int"))
    .withColumn("relative_month",
        ((F.year("date") - today_year) * 12 + (F.month("date") - today_month)).cast("int"))
    .withColumn("relative_quarter",
        ((F.year("date") - today_year) * 4 + (F.quarter("date") - today_quarter)).cast("int"))
    .withColumn(
        "relative_week",
        (
            F.datediff(
                F.col("start_of_week"),
                F.date_sub(today, (F.datediff(today, F.lit("1900-01-01")) % 7).cast("int")),
            ) / 7
        ).cast("int"),
    )
)

# Constant column: Monday of TODAY's week
_today_py = dt.date.today()
_week_start_py = _today_py - dt.timedelta(days=_today_py.weekday())
dim = dim.withColumn("start_of_current_week", F.to_date(F.lit(_week_start_py.isoformat())))

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# 5. relative_business_day — replaces an O(n²) DAX RANKX(FILTER(...)) pattern
# with an O(n) cumulative window function. NULL on non-business days.

_biz_window = Window.orderBy("date").rowsBetween(Window.unboundedPreceding, 0)
dim = dim.withColumn(
    "_cumul_biz",
    F.sum(F.when(F.col("is_business_day"), F.lit(1)).otherwise(F.lit(0))).over(_biz_window),
)

# Today's cumulative count; if today is a weekend/holiday, fall back to the
# most recent prior business day so relative_business_day stays meaningful.
_today_str = _today_py.isoformat()
_today_row = (
    dim.filter(F.col("date") == F.to_date(F.lit(_today_str)))
    .select("_cumul_biz")
    .first()
)
if _today_row and _today_row[0] is not None:
    _today_cumul = int(_today_row[0])
else:
    _fallback = (
        dim.filter(
            (F.col("is_business_day")) & (F.col("date") < F.to_date(F.lit(_today_str)))
        )
        .orderBy(F.col("date").desc())
        .select("_cumul_biz")
        .first()
    )
    _today_cumul = int(_fallback[0]) if _fallback else 0

dim = (
    dim
    .withColumn(
        "relative_business_day",
        F.when(
            F.col("is_business_day"),
            (F.col("_cumul_biz") - F.lit(_today_cumul)).cast("int"),
        ).otherwise(F.lit(None).cast("int")),
    )
    .drop("_cumul_biz")
)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# 6. month_index — dense rank descending by year_month (latest = 1)

_month_idx_window = Window.orderBy(F.col("year_month").desc())
dim = dim.withColumn("month_index", F.dense_rank().over(_month_idx_window).cast("int"))

dim = dim.withColumn("gold_built_at", F.current_timestamp())

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# 7. Final column order + write

result = dim.select(
    "date_key", "date", "year", "quarter", "month", "day",
    "day_of_week", "day_of_year", "week_of_year",
    "month_name", "day_name", "is_weekend",
    "fiscal_year", "fiscal_quarter", "year_month", "year_quarter",
    "first_day_of_month", "last_day_of_month",
    "first_day_of_quarter", "last_day_of_quarter",
    "start_of_week",
    "day_of_quarter", "week_of_month", "week_of_quarter", "month_of_quarter",
    "is_business_day", "is_holiday", "holiday_usa",
    "relative_day", "relative_week", "relative_month", "relative_quarter",
    "relative_business_day", "start_of_current_week",
    "month_index",
    "gold_built_at",
)

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

# Verification

print("=== Today + adjacent rows ===")
spark.sql(f"""
  SELECT date, day_name, is_business_day, holiday_usa,
         relative_day, relative_week, relative_quarter, relative_business_day
  FROM {GOLD_TABLE}
  WHERE relative_day BETWEEN -3 AND 3
  ORDER BY date
""").show(truncate=False)

print("=== Holidays in 2026 ===")
spark.sql(f"""
  SELECT date, holiday_usa FROM {GOLD_TABLE}
  WHERE year = 2026 AND is_holiday
  ORDER BY date
""").show(20, truncate=False)

print("=== Business days per quarter (2026) ===")
spark.sql(f"""
  SELECT year_quarter, COUNT(*) AS days,
         SUM(CASE WHEN is_business_day THEN 1 ELSE 0 END) AS business_days
  FROM {GOLD_TABLE}
  WHERE year = 2026
  GROUP BY year_quarter
  ORDER BY year_quarter
""").show(truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
