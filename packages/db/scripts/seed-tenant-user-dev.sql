-- Seed dev tenant_user rows.
--
-- Maps the local developer to the acme-pharma tenant so the RLS filter has
-- something to resolve. Runs against Supabase. Idempotent.
--
-- Replace the email below with whatever you sign into Clerk as, OR add
-- additional rows for test users you create in Clerk's dev dashboard.

INSERT INTO tenant_user (tenant_id, user_email, effective_territory_ids)
SELECT t.id, 'james.waterman@jjwconsulting.net', NULL
FROM tenant t
WHERE t.slug = 'acme-pharma'
ON CONFLICT (tenant_id, user_email) DO NOTHING;

-- Verify
SELECT t.slug, tu.user_email, tu.effective_territory_ids, tu.updated_at
FROM tenant_user tu
JOIN tenant t ON t.id = tu.tenant_id
ORDER BY t.slug, tu.user_email;
