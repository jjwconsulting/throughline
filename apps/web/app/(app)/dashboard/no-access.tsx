import type { ScopeResolution } from "@/lib/scope";

export default function NoAccess({
  email,
  reason,
}: {
  email: string | null;
  // The narrow case the resolver returned — used to give a useful hint.
  reason: Extract<ScopeResolution, { ok: false }>["reason"] | undefined;
}) {
  const message =
    reason === "rep_missing_user_key"
      ? "Your account is provisioned as a rep but has no Veeva user mapping yet. An admin needs to set veeva_user_key on tenant_user."
      : reason === "manager_no_team"
        ? "Your account is provisioned as a manager but has no team mapping yet. An admin needs to set veeva_user_key so we can resolve your reports."
        : "Your account isn't associated with a tenant yet. Contact your administrator to get provisioned.";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl">Dashboard</h1>
      </div>
      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-12 text-center">
        <p className="font-medium">No access</p>
        <p className="text-sm text-[var(--color-ink-muted)] mt-2 max-w-md mx-auto">
          {email ? (
            <>
              <span className="font-mono">{email}</span>
              <br />
            </>
          ) : null}
          {message}
        </p>
      </div>
    </div>
  );
}
