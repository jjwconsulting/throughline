-- Seed field-map for silver.user from Veeva user__sys.
--
-- user__sys mixes __v / __sys / __c suffixes (it's the Salesforce-style
-- user object Veeva CRM is built on). No HCP/HCO-style discriminator —
-- all rows in user__sys are users. Active and inactive both included;
-- old calls reference inactive reps, so silver keeps the full population.
-- Idempotent.

INSERT INTO tenant_source_field_map (
  tenant_id, source_system, silver_table, silver_column,
  bronze_source_table, bronze_source_column, updated_by
)
SELECT
  t.id,
  'veeva'::source_system,
  'user'::silver_table,
  v.silver_column,
  'veeva_obj_user__sys',
  v.bronze_column,
  'seed-script'
FROM tenant t
CROSS JOIN (VALUES
  ('name',                  'name__v'),
  ('first_name',            'first_name__sys'),
  ('last_name',             'last_name__sys'),
  ('email',                 'email__sys'),
  ('username',              'username__sys'),
  ('federated_id',          'federated_id__sys'),
  ('employee_number',       'employee_number__v'),
  ('title',                 'title__sys'),
  ('department',            'department__v'),
  ('division',              'division__v'),
  ('profile',               'profile_name__v'),
  ('security_profile',      'security_profile__sys'),
  ('user_type',             'user_type__v'),
  ('manager_id',            'manager__sys'),
  ('primary_territory_id',  'primary_territory__v'),
  ('phone_office',          'office_phone__sys'),
  ('phone_mobile',          'mobile_phone__sys'),
  ('street',                'street__v'),
  ('city',                  'city__v'),
  ('state',                 'state_province__v'),
  ('postal_code',           'postalcode__v'),
  ('country',               'country__v'),
  ('locale',                'locale__sys'),
  ('timezone',              'timezone__sys'),
  ('language',              'language__sys'),
  ('status',                'status__v'),
  ('is_active',             'isactive__v'),
  ('activation_date',       'activation_date__sys'),
  ('inactivation_date',     'inactivation_date__sys'),
  ('last_login',            'last_login__sys')
) AS v(silver_column, bronze_column)
WHERE t.slug = 'acme-pharma'
ON CONFLICT (tenant_id, silver_table, silver_column) DO UPDATE
SET bronze_source_column = EXCLUDED.bronze_source_column,
    bronze_source_table  = EXCLUDED.bronze_source_table,
    updated_at           = now();

SELECT silver_column, bronze_source_column
FROM tenant_source_field_map
WHERE silver_table = 'user'
ORDER BY silver_column;
