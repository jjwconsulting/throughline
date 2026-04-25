-- Seed field-map for silver.sale from Fennec's IntegriChain 867 file.
--
-- The IntegriChain 867 (Product Transfer/Resale) file is the standard
-- distributor data flow: line items per (date, ship-from-DC, ship-to-POC,
-- product). 43 source columns; we pick ~20 for silver. Address fields,
-- detailed classifications, etc. all kept; the operational EU/PU/MU
-- variations consolidate to single `units` (eaches, the "EU" column).
--
-- Bronze table: bronze_fennecpharma.sftp_sales_867 (created by sftp_ingest
-- after files land at Files/sftp/fennecpharma/sales_867/*.csv).
--
-- IntegriChain sends inception-to-date files — each new file replaces the
-- prior snapshot. The companion seed `seed-fennec-sftp-feed.sql` registers
-- this feed as feed_type='full_snapshot' so silver_sale_build only reads
-- rows from the latest source_file (avoids accumulating duplicate history).

INSERT INTO tenant_source_field_map (
  tenant_id, source_system, silver_table, silver_column,
  bronze_source_table, bronze_source_column, updated_by
)
SELECT
  t.id,
  'sftp'::source_system,
  'sale'::silver_table,
  v.silver_column,
  'sftp_sales_867',
  v.bronze_column,
  'seed-script'
FROM tenant t
CROSS JOIN (VALUES
  -- When (Day Date is the actual transaction day; Process Date is when
  -- IC processed it — we use Day Date for the transaction grain)
  ('transaction_date',         'Day Date'),
  ('transaction_type',         'Transaction Type'),

  -- Account (Ship-To = end customer / point of care; this is what maps
  -- to Veeva. Ship-From is the wholesaler distribution center, which
  -- we don't currently track as an entity).
  ('distributor_account_id',   'Ship-To DEA/HIN/Customer Id'),
  ('distributor_account_name', 'Ship-To POC Name'),
  ('account_address_line1',    'Ship-To POC Address'),
  ('account_city',             'Ship-To POC City'),
  ('account_state',            'Ship-To POC State'),
  ('account_postal_code',      'Ship-To POC Zip'),

  -- Geography / classification (no source-side territory in 867; rep
  -- attribution will derive from account_xref → silver.user_territory)
  ('channel',                  'Ship-To Point of Care Channel'),
  ('class_of_trade',           'Ship-To Point of Care Class of Trade'),

  -- Product
  ('product_ndc',              'NDC'),
  ('product_name',             'Brand'),
  ('product_pack_description', 'Package Description'),
  ('brand',                    'Brand'),
  ('business_unit',            'Business Unit'),

  -- Quantities + dollars
  -- EU (each-units) is the canonical eaches measure.
  ('units',                    'sum(867 Qty Sold (EU))'),
  -- PU (pack-units) kept as units_packs for fidelity if any report needs it.
  ('units_packs',              'sum(867 Qty Sold (PU))'),
  -- WAC-c is current Wholesale Acquisition Cost (gross dollars; net
  -- requires contract-pricing adjustments we don't have here).
  -- Per James: most of TriSalus/Fennec work was units-focused; dollars
  -- are still important. WAC-c stored as gross_dollars; net_dollars
  -- left null for IC sources (no clean net price in 867).
  ('gross_dollars',            'sum(867 Qty Sold (WAC-c))'),

  -- Reference
  ('invoice_number',           'Invoice Number')
) AS v(silver_column, bronze_column)
WHERE t.slug = 'acme-pharma'
ON CONFLICT (tenant_id, silver_table, silver_column) DO UPDATE
SET bronze_source_table  = EXCLUDED.bronze_source_table,
    bronze_source_column = EXCLUDED.bronze_source_column,
    updated_by           = EXCLUDED.updated_by,
    updated_at           = now();
