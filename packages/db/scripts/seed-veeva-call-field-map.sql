-- Seed field-map for silver.call from Veeva call2__v.
--
-- ~30 columns picked from call2__v's ~200. Focus on the call header (who
-- called whom, when, what kind, status, location, notes). Skipping the
-- shipping/sample/DEA/CLM/signature-image fields — those belong in dedicated
-- silver entities (e.g. silver.sample_drop) when we need them.
--
-- Custom fennec fields included where activity-relevant (materials used,
-- MSL materials).

INSERT INTO tenant_source_field_map (
  tenant_id, source_system, silver_table, silver_column,
  bronze_source_table, bronze_source_column, updated_by
)
SELECT
  t.id,
  'veeva'::source_system,
  'call'::silver_table,
  v.silver_column,
  'veeva_obj_call2__v',
  v.bronze_column,
  'seed-script'
FROM tenant t
CROSS JOIN (VALUES
  -- Identity
  ('name',                 'name__v'),
  ('subject',              'subject__v'),

  -- Foreign keys (resolved to dims in gold)
  ('account_id',           'account__v'),
  ('child_account_id',     'child_account__v'),
  ('person_id',            'person__v'),
  ('owner_user_id',        'ownerid__v'),
  ('user_id',              'user__v'),
  ('territory_id',         'territory__v'),
  ('created_by_user_id',   'created_by__v'),
  ('parent_call_id',       'parent_call__v'),

  -- When
  ('call_date',            'call_date__v'),
  ('call_datetime',        'call_datetime__v'),
  ('duration',             'duration__v'),
  ('signature_date',       'signature_date__v'),
  ('signature_timestamp',  'signature_timestamp__v'),
  ('submit_timestamp',     'submit_timestamp__v'),

  -- Type / classification
  ('call_type',            'call_type__v'),
  ('call_channel',         'call_channel__v'),
  ('call_status',          'call2_status__v'),
  ('status',               'status__v'),
  ('signature_status',     'call_signature_status__v'),
  ('check_in_status',      'check_in_status__v'),
  ('is_sampled_call',      'is_sampled_call__v'),
  ('is_remote_meeting',    'remote_meeting__v'),

  -- Where
  ('city',                 'city__v'),
  ('state',                'state_province__v'),
  ('postal_code',          'zip__v'),
  ('location',             'location__v'),

  -- Notes
  ('comments',             'call_comments__v'),
  ('notes',                'call_notes__v'),
  ('pre_call_notes',       'pre_call_notes__v'),
  ('next_call_notes',      'next_call_notes__v'),

  -- Products discussed (denormalized hint; gold can join detail tables)
  ('detailed_products',    'detailed_products__v'),
  ('product_priority_1',   'product_priority_1__v'),
  ('product_priority_2',   'product_priority_2__v'),
  ('product_priority_3',   'product_priority_3__v'),

  -- Fennec custom (activity reporting)
  ('materials_used',       'fen_materials_used__c'),
  ('msl_materials_used',   'fen_msl_materials_used__c')
) AS v(silver_column, bronze_column)
WHERE t.slug = 'acme-pharma'
ON CONFLICT (tenant_id, silver_table, silver_column) DO UPDATE
SET bronze_source_column = EXCLUDED.bronze_source_column,
    bronze_source_table  = EXCLUDED.bronze_source_table,
    updated_at           = now();

SELECT silver_column, bronze_source_column
FROM tenant_source_field_map
WHERE silver_table = 'call'
ORDER BY silver_column;
