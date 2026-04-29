// Helper for building "Open in Veeva" deep links to account records.
//
// Veeva sells two CRM products with different URL patterns:
//   - Veeva Vault (hash-routed UI, host like *.veevavault.com):
//     `https://<host>/ui/#object/account__v/<account_id>`
//   - Veeva CRM on Salesforce (Lightning):
//     `https://<host>/lightning/r/Account/<account_id>/view`
//
// Fennec uses Vault. We hardcode the Vault pattern today; when a
// tenant on Veeva CRM (Salesforce) lands, this becomes a per-tenant
// config field on `tenant_veeva` (e.g. `crm_account_url_template`).
// See feedback_veeva_url_per_tenant memory for the full TODO.

export function veevaAccountUrl(
  vaultDomain: string | null,
  veevaAccountId: string | null,
): string | null {
  if (!vaultDomain || !veevaAccountId) return null;
  return `https://${vaultDomain}/ui/#object/account__v/${encodeURIComponent(veevaAccountId)}`;
}
