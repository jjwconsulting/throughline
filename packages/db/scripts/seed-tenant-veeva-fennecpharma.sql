-- Seed tenant_veeva row for acme-pharma pointing at the fennec dev Vault.
--
-- Vault DNS is not strictly secret (visible in any URL the client uses),
-- so we commit it. Username goes in the row too. Password lives ONLY in
-- the runtime env var named below.
--
-- Before running:
--   1. Replace <YOUR-VEEVA-USERNAME> with the user account from
--      vapil_settings.json
--   2. Set the env var locally and in Fabric notebook params:
--      VEEVA_PASSWORD_ACME_PHARMA=<your-veeva-password>
--
-- Idempotent: re-running updates the row.

INSERT INTO tenant_veeva (
  tenant_id, vault_domain, username, password_secret_uri, enabled
)
SELECT
  t.id,
  'fennecpharma-crm.veevavault.com',
  '<YOUR-VEEVA-USERNAME>',
  'env:VEEVA_PASSWORD_ACME_PHARMA',
  true
FROM tenant t
WHERE t.slug = 'acme-pharma'
ON CONFLICT (tenant_id) DO UPDATE
SET vault_domain        = EXCLUDED.vault_domain,
    username            = EXCLUDED.username,
    password_secret_uri = EXCLUDED.password_secret_uri,
    enabled             = EXCLUDED.enabled,
    updated_at          = now();

-- Verify
SELECT t.slug, tv.vault_domain, tv.username, tv.password_secret_uri, tv.enabled
FROM tenant_veeva tv
JOIN tenant t ON t.id = tv.tenant_id;
