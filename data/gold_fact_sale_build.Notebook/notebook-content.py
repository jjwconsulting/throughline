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

# # Gold build: fact_sale
# Builds `gold.fact_sale` from `silver.sale` with:
#   - Account resolution via `silver.account_xref` →
#     `gold.dim_hcp` or `gold.dim_hco` (mutually exclusive per row)
#   - Date FK via `gold.dim_date.date_key` (YYYYMMDD as INT)
#   - Signed measures derived from `transaction_type` so SUM() across the
#     table yields net (sales − returns)
#   - Transfers FILTERED OUT (legacy systems ignored them; net inventory
#     impact across the whole population is zero, so each transfer leg
#     would double-count if included). Stays in silver for audit.
# Unmapped accounts: rows survive with NULL account_key and NULL
# account_type. The raw `distributor_account_id` is preserved so a
# future `/admin/mappings` UI + signal can surface them as work to do.

# CELL ********************

GOLD_TABLE = "gold.fact_sale"

# Transaction types we keep in gold. TRANSFERS go to /dev/null (kept in
# silver for audit, ignored for analytics — matches legacy system behavior).
ANALYTICS_TRANSACTION_TYPES = ("SALES", "RETURNS")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

spark.sql("CREATE SCHEMA IF NOT EXISTS gold")
spark.sql(f"""
CREATE TABLE IF NOT EXISTS {GOLD_TABLE} (
  sale_key                   STRING    NOT NULL,
  tenant_id                  STRING    NOT NULL,
  source_system              STRING    NOT NULL,
  source_table               STRING    NOT NULL,
  -- When
  transaction_date_key       INT,
  transaction_date           DATE,
  transaction_type           STRING    NOT NULL,
  -- Account: resolution via account_xref. NULL when unmapped (kept in fact
  -- so /admin/mappings can list them; signal alerts admins to fix).
  distributor_account_id     STRING,
  distributor_account_name   STRING,
  account_key                STRING,
  account_type               STRING,    -- 'HCP' / 'HCO' / NULL when unmapped
  veeva_account_id           STRING,    -- the resolved Veeva id (denormalized)
  -- Sales attribution (Phase A v1, current-state):
  --   account_key → bridge_account_territory (is_primary=true) → territory_key
  --   territory_key → dim_territory.current_rep_user_key
  -- Three NULL cascade buckets surfaced on the dashboard health view:
  --   account_key NULL              → unmapped distributor (no path)
  --   no primary bridge row         → "Account not in any territory"
  --   territory has no current rep  → "Territory unassigned"
  territory_key              STRING,
  rep_user_key               STRING,
  attribution_status         STRING,    -- 'attributed' / 'unmapped' / 'no_territory' / 'no_rep'
  -- Geographic context
  account_address_line1      STRING,
  account_city               STRING,
  account_state              STRING,
  account_postal_code        STRING,
  distributor_territory      STRING,    -- TriSalus-style fallback
  -- Classification
  channel                    STRING,
  class_of_trade             STRING,
  business_unit              STRING,
  brand                      STRING,
  -- Product (denormalized; promote to dim_product when we build it)
  product_ndc                STRING,
  product_source_id          STRING,
  product_name               STRING,
  product_pack_description   STRING,
  -- Raw measures (positive numbers)
  units                      DOUBLE,
  units_packs                DOUBLE,
  net_dollars                DOUBLE,
  gross_dollars              DOUBLE,
  -- Signed measures (RETURNS negated; SALES positive). Use these in SUM()
  -- queries to get net amounts directly.
  signed_units               DOUBLE,
  signed_net_dollars         DOUBLE,
  signed_gross_dollars       DOUBLE,
  -- Refs
  invoice_number             STRING,
  gold_built_at              TIMESTAMP NOT NULL
) USING DELTA
""")

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

# Account resolution strategy:
#
#   silver.sale.distributor_account_id
#     -> silver.account_xref (tenant + source_key match)
#     -> veeva_account_id
#       -> gold.dim_hcp (when veeva account is a person)
#       OR gold.dim_hco (when veeva account is an organization)
#         -> hcp_key | hco_key  (account_key)
#       -> gold.bridge_account_territory (is_primary=true)
#         -> territory_key
#         -> gold.dim_territory.current_rep_user_key
#
# Two LEFT JOINs to dim_hcp and dim_hco; COALESCE the keys. account_type
# is derived from which side matched. Mutually exclusive — one Veeva
# account is either an HCP or an HCO, never both.
#
# Sales attribution (Phase A): cascade through bridge + dim_territory to
# resolve territory_key + rep_user_key. attribution_status records WHICH
# step failed when null, so the health surface can break out the buckets.
#
# Note: account_xref join doesn't filter by source_system. Per-source
# xref is a future refinement — for v1 a tenant has one canonical mapping.

build_sql = f"""
SELECT
  -- sale_key: stable across reruns. silver.sale.id is uuid() (not stable),
  -- so hash the natural keys instead.
  md5(concat_ws('|',
    s.tenant_id, s.source_table,
    COALESCE(CAST(s.transaction_date AS STRING), ''),
    COALESCE(s.distributor_account_id, ''),
    COALESCE(s.product_ndc, s.product_source_id, ''),
    COALESCE(CAST(s.units AS STRING), ''),
    COALESCE(s.invoice_number, ''),
    COALESCE(s.transaction_type, '')
  )) AS sale_key,
  s.tenant_id,
  s.source_system,
  s.source_table,
  CAST(date_format(s.transaction_date, 'yyyyMMdd') AS INT) AS transaction_date_key,
  s.transaction_date,
  s.transaction_type,
  s.distributor_account_id,
  s.distributor_account_name,
  COALESCE(hcp.hcp_key, hco.hco_key)                     AS account_key,
  CASE
    WHEN hcp.hcp_key IS NOT NULL THEN 'HCP'
    WHEN hco.hco_key IS NOT NULL THEN 'HCO'
    ELSE NULL
  END                                                    AS account_type,
  xref.veeva_account_id,
  bat.territory_key                                       AS territory_key,
  dt.current_rep_user_key                                 AS rep_user_key,
  CASE
    WHEN COALESCE(hcp.hcp_key, hco.hco_key) IS NULL                  THEN 'unmapped'
    WHEN bat.territory_key IS NULL                                   THEN 'no_territory'
    WHEN dt.current_rep_user_key IS NULL                             THEN 'no_rep'
    ELSE 'attributed'
  END                                                     AS attribution_status,
  s.account_address_line1, s.account_city, s.account_state, s.account_postal_code,
  s.distributor_territory,
  s.channel, s.class_of_trade, s.business_unit, s.brand,
  s.product_ndc, s.product_source_id, s.product_name, s.product_pack_description,
  s.units,
  s.units_packs,
  s.net_dollars,
  s.gross_dollars,
  -- Signed measures normalize for net-math: RETURNS always negative,
  -- SALES always positive. Uses -ABS / ABS so it works regardless of the
  -- source's own sign convention:
  --   IntegriChain pre-signs returns as negative in the EDI 867 (standard)
  --   Some other systems send positive units + a RETURNS type label
  -- Both cases: signed_units for a RETURNS row ends up negative. SUM()
  -- over all rows = net (sales - returns). NULL stays NULL.
  CASE WHEN s.transaction_type = 'RETURNS' THEN -ABS(s.units)         ELSE ABS(s.units)         END AS signed_units,
  CASE WHEN s.transaction_type = 'RETURNS' THEN -ABS(s.net_dollars)   ELSE ABS(s.net_dollars)   END AS signed_net_dollars,
  CASE WHEN s.transaction_type = 'RETURNS' THEN -ABS(s.gross_dollars) ELSE ABS(s.gross_dollars) END AS signed_gross_dollars,
  s.invoice_number,
  current_timestamp() AS gold_built_at
FROM silver.sale s
LEFT JOIN silver.account_xref xref
  ON xref.tenant_id = s.tenant_id
  AND xref.source_key = s.distributor_account_id
LEFT JOIN gold.dim_hcp hcp
  ON hcp.tenant_id = s.tenant_id
  AND hcp.veeva_account_id = xref.veeva_account_id
LEFT JOIN gold.dim_hco hco
  ON hco.tenant_id = s.tenant_id
  AND hco.veeva_account_id = xref.veeva_account_id
-- Sales attribution: account_key → primary territory → current rep
LEFT JOIN gold.bridge_account_territory bat
  ON bat.tenant_id   = s.tenant_id
  AND bat.account_key = COALESCE(hcp.hcp_key, hco.hco_key)
  AND bat.is_primary = true
LEFT JOIN gold.dim_territory dt
  ON dt.tenant_id      = s.tenant_id
  AND dt.territory_key = bat.territory_key
WHERE s.transaction_type IN ({", ".join(f"'{t}'" for t in ANALYTICS_TRANSACTION_TYPES)})
"""

result = spark.sql(build_sql)
row_count = result.count()

(
    result.write
    .format("delta")
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

print("=== Account resolution rates ===")
spark.sql(f"""
  SELECT
    COUNT(*) AS total_rows,
    SUM(CASE WHEN account_type = 'HCP'  THEN 1 ELSE 0 END) AS as_hcp,
    SUM(CASE WHEN account_type = 'HCO'  THEN 1 ELSE 0 END) AS as_hco,
    SUM(CASE WHEN account_type IS NULL  THEN 1 ELSE 0 END) AS unmapped,
    ROUND(100.0 * SUM(CASE WHEN account_type IS NOT NULL THEN 1 ELSE 0 END) / COUNT(*), 1) AS pct_mapped
  FROM {GOLD_TABLE}
""").show(truncate=False)

print("=== Sales attribution rates (Phase A v1) ===")
spark.sql(f"""
  SELECT
    attribution_status,
    COUNT(*) AS rows,
    ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) AS pct_of_rows,
    ROUND(SUM(signed_gross_dollars), 0) AS signed_gross_dollars,
    ROUND(100.0 * SUM(signed_gross_dollars) / SUM(SUM(signed_gross_dollars)) OVER (), 1) AS pct_of_dollars
  FROM {GOLD_TABLE}
  GROUP BY attribution_status
  ORDER BY signed_gross_dollars DESC
""").show(truncate=False)

print("=== Top 10 unmapped distributor accounts ===")
spark.sql(f"""
  SELECT distributor_account_id, distributor_account_name, account_state,
         COUNT(*) AS rows,
         ROUND(SUM(signed_units), 0) AS signed_units,
         ROUND(SUM(signed_gross_dollars), 0) AS signed_gross_dollars,
         MAX(transaction_date) AS last_seen
  FROM {GOLD_TABLE}
  WHERE account_key IS NULL
  GROUP BY distributor_account_id, distributor_account_name, account_state
  ORDER BY rows DESC
""").show(10, truncate=False)

print("=== Signed totals by transaction type ===")
spark.sql(f"""
  SELECT transaction_type,
         COUNT(*) AS rows,
         ROUND(SUM(units), 0) AS raw_units,
         ROUND(SUM(signed_units), 0) AS signed_units,
         ROUND(SUM(gross_dollars), 0) AS raw_gross_dollars,
         ROUND(SUM(signed_gross_dollars), 0) AS signed_gross_dollars
  FROM {GOLD_TABLE}
  GROUP BY transaction_type
""").show(truncate=False)

print("=== Top 10 accounts by signed gross dollars (mapped only) ===")
spark.sql(f"""
  SELECT
    distributor_account_name AS source_name,
    account_type,
    account_state,
    ROUND(SUM(signed_gross_dollars), 0) AS signed_gross_dollars,
    ROUND(SUM(signed_units), 0) AS signed_units
  FROM {GOLD_TABLE}
  WHERE account_key IS NOT NULL
  GROUP BY distributor_account_name, account_type, account_state
  ORDER BY signed_gross_dollars DESC NULLS LAST
""").show(10, truncate=False)

print("=== Sales by year-quarter (sanity) ===")
spark.sql(f"""
  SELECT d.year_quarter,
         ROUND(SUM(f.signed_units), 0) AS signed_units,
         ROUND(SUM(f.signed_gross_dollars), 0) AS signed_gross_dollars
  FROM {GOLD_TABLE} f
  JOIN gold.dim_date d ON d.date_key = f.transaction_date_key
  GROUP BY d.year_quarter
  ORDER BY d.year_quarter
""").show(20, truncate=False)

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
