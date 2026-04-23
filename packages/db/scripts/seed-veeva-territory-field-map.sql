-- Seed field-map for silver.territory from Veeva territory__v.
-- Tiny table (~50 rows in fennec). Picklist translation only matters for
-- country and status.

INSERT INTO tenant_source_field_map (
  tenant_id, source_system, silver_table, silver_column,
  bronze_source_table, bronze_source_column, updated_by
)
SELECT
  t.id,
  'veeva'::source_system,
  'territory'::silver_table,
  v.silver_column,
  'veeva_obj_territory__v',
  v.bronze_column,
  'seed-script'
FROM tenant t
CROSS JOIN (VALUES
  ('name',                'name__v'),
  ('api_name',            'api_name__v'),
  ('description',         'description__v'),
  ('parent_territory_id', 'parent_territory__v'),
  ('owner_user_id',       'ownerid__v'),
  ('country',             'country__v'),
  ('status',              'status__v')
) AS v(silver_column, bronze_column)
WHERE t.slug = 'acme-pharma'
ON CONFLICT (tenant_id, silver_table, silver_column) DO UPDATE
SET bronze_source_column = EXCLUDED.bronze_source_column,
    bronze_source_table  = EXCLUDED.bronze_source_table,
    updated_at           = now();

SELECT silver_column, bronze_source_column
FROM tenant_source_field_map
WHERE silver_table = 'territory'
ORDER BY silver_column;
