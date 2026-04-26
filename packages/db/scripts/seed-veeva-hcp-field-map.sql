-- Seed field-map rows for silver.hcp built from Veeva account__v.
--
-- Standard Veeva CDM field names with one fennec-custom (fen_hcp_tier__c).
-- Other tenants will have different custom fields → different rows here.
--
-- Run after seed-tenant-veeva-fennecpharma.sql + a successful FULL ingest.
-- Idempotent.

INSERT INTO tenant_source_field_map (
  tenant_id, source_system, silver_table, silver_column,
  bronze_source_table, bronze_source_column, updated_by
)
SELECT
  t.id,
  'veeva'::source_system,
  'hcp'::silver_table,
  v.silver_column,
  'veeva_obj_account__v',
  v.bronze_column,
  'seed-script'
FROM tenant t
CROSS JOIN (VALUES
  ('npi',                 'npi__v'),
  -- Cross-system identifiers used by /admin/mappings upload's multi-field
  -- resolution. Less commonly used for HCPs (NPI is the universal HCP
  -- key), but worth pulling so the same resolution path works whichever
  -- side an admin's source file references.
  ('network_id',          'veeva_network_id__v'),
  ('name',                'formatted_name__v'),
  ('first_name',          'first_name_cda__v'),
  ('last_name',           'last_name_cda__v'),
  ('middle_name',         'middle_name_cda__v'),
  ('prefix',              'prefix_cda__v'),
  ('suffix',              'suffix_cda__v'),
  ('credentials',         'credentials__v'),
  ('specialty_primary',   'specialty_1__v'),
  ('specialty_secondary', 'specialty_2__v'),
  ('gender',              'gender__v'),
  ('email',               'email_cda__v'),
  ('phone_office',        'office_phone_cda__v'),
  ('phone_mobile',        'mobile_phone_cda__v'),
  ('city',                'city_cda__v'),
  ('state',               'primary_state_province__v'),
  ('postal_code',         'postal_code_cda__v'),
  ('country',             'primary_country__v'),
  ('is_prescriber',       'prescriber_cda__v'),
  ('is_kol',              'kol_cda__v'),
  ('is_speaker',          'speaker_cda__v'),
  ('is_investigator',     'investigator_cda__v'),
  ('status',              'status_cda__v'),
  ('segmentation',        'segmentations__v'),
  ('tier',                'fen_hcp_tier__c'),
  ('account_type',        'fen_hcp_account_type__c'),
  ('source_id',           'fen_fenid__c')
) AS v(silver_column, bronze_column)
WHERE t.slug = 'acme-pharma'
ON CONFLICT (tenant_id, silver_table, silver_column) DO UPDATE
SET bronze_source_column = EXCLUDED.bronze_source_column,
    bronze_source_table  = EXCLUDED.bronze_source_table,
    updated_at           = now();

-- Verify
SELECT silver_column, bronze_source_column
FROM tenant_source_field_map
WHERE silver_table = 'hcp'
ORDER BY silver_column;
