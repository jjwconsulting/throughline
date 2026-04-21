-- Seed field-map rows for silver.account_xref built from sftp_account_mapping bronze.
--
-- One-off dev seed. When the admin UI for field-map editing exists, this is
-- what that UI will write. Run in Supabase SQL editor.
--
-- Prerequisites:
--   - acme-pharma tenant exists (create via /admin/tenants)
--   - silver_table enum includes 'account_xref' (migration 0001 applied)
--
-- Idempotent: ON CONFLICT updates the bronze column if it changed.

INSERT INTO tenant_source_field_map (
  tenant_id,
  source_system,
  silver_table,
  silver_column,
  bronze_source_table,
  bronze_source_column,
  updated_by
)
SELECT
  t.id,
  'sftp'::source_system,
  'account_xref'::silver_table,
  v.silver_column,
  'sftp_account_mapping',
  v.bronze_column,
  'seed-script'
FROM tenant t
CROSS JOIN (VALUES
  ('source_key',       'ID'),
  ('veeva_account_id', 'VeevaID'),
  ('channel',          'Channel'),
  ('dea',              'DEA'),
  ('name',             'name'),
  ('city',             'cityName'),
  ('state',            'stateOrProvinceCode'),
  ('postal_code',      'postalCode')
) AS v(silver_column, bronze_column)
WHERE t.slug = 'acme-pharma'
ON CONFLICT (tenant_id, silver_table, silver_column) DO UPDATE
SET bronze_source_column = EXCLUDED.bronze_source_column,
    bronze_source_table  = EXCLUDED.bronze_source_table,
    updated_at           = now();

-- Verify
SELECT tenant_id, source_system, silver_table, silver_column, bronze_source_column
FROM tenant_source_field_map
WHERE silver_table = 'account_xref'
ORDER BY silver_column;
