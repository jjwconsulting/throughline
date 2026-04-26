-- Seed field-map rows for silver.hco built from Veeva account__v.
--
-- Source is the same bronze table as silver.hcp (account__v); the silver
-- build splits HCP vs HCO by `ispersonaccount__v`. Different silver columns
-- though — institutional attributes (beds, AHA, parent account, tax ID, etc.)
-- instead of provider attributes (NPI, specialty, credentials).
--
-- Idempotent.

INSERT INTO tenant_source_field_map (
  tenant_id, source_system, silver_table, silver_column,
  bronze_source_table, bronze_source_column, updated_by
)
SELECT
  t.id,
  'veeva'::source_system,
  'hco'::silver_table,
  v.silver_column,
  'veeva_obj_account__v',
  v.bronze_column,
  'seed-script'
FROM tenant t
CROSS JOIN (VALUES
  ('name',                 'formatted_name__v'),
  ('hco_type',             'hco_type_cda__v'),
  ('hospital_type',        'hospital_type__v'),
  ('hco_class',            'account_class__v'),
  ('account_group',        'account_group__v'),
  -- Cross-system identifiers used by /admin/mappings upload's multi-field
  -- resolution. Source-tenant variability: each Veeva tenant may have
  -- different subsets of these populated. Silver build silently emits
  -- NULL (with a warning) for any whose bronze column is missing.
  -- Network ID is the canonical cross-system pharma master-data spine —
  -- transitioning clients commonly use it as their mapping-file join key.
  ('network_id',           'veeva_network_id__v'),
  ('npi',                  'npi__v'),
  ('aha_id',               'aha__v'),
  ('bed_count',            'beds__c'),
  ('email',                'vt_hco_email__c'),
  ('phone_office',         'office_phone_cda__v'),
  ('city',                 'city_cda__v'),
  ('state',                'primary_state_province__v'),
  ('postal_code',          'postal_code_cda__v'),
  ('country',              'primary_country__v'),
  ('parent_account_id',    'primary_parent__v'),
  ('status',               'status_cda__v'),
  ('segmentation',         'segmentations__v'),
  ('tier',                 'fen_hco_tier__c'),
  ('account_type',         'fen_hco_account_type__c'),
  ('focus_area_1',         'vt_hco_focus_area_1__c'),
  ('major_class_of_trade', 'vt_major_class_of_trade__c'),
  ('tax_id',               'vt_hco_tax_id__c'),
  ('source_id',            'fen_fenid__c')
) AS v(silver_column, bronze_column)
WHERE t.slug = 'acme-pharma'
ON CONFLICT (tenant_id, silver_table, silver_column) DO UPDATE
SET bronze_source_column = EXCLUDED.bronze_source_column,
    bronze_source_table  = EXCLUDED.bronze_source_table,
    updated_at           = now();

-- Verify
SELECT silver_column, bronze_source_column
FROM tenant_source_field_map
WHERE silver_table = 'hco'
ORDER BY silver_column;
