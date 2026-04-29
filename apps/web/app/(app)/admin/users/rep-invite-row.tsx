"use client";

import { useActionState } from "react";
import { inviteUserAction, type InviteUserState } from "./actions";
import type { VeevaRep } from "./veeva-reps";

const initial: InviteUserState = { error: null, success: null };

export default function RepInviteRow({
  rep,
  tenantSlug,
}: {
  rep: VeevaRep;
  tenantSlug: string;
}) {
  const [state, formAction, isPending] = useActionState(
    inviteUserAction,
    initial,
  );

  const isProvisioned = rep.provisioned;
  const hasEmail = !!rep.email;

  return (
    <tr className="border-t border-[var(--color-border)] align-top">
      <td className="px-4 py-3">
        <div className="font-medium">{rep.name}</div>
        {rep.title ? (
          <div className="text-xs text-[var(--color-ink-muted)]">
            {rep.title}
          </div>
        ) : null}
      </td>
      <td className="px-4 py-3 text-[var(--color-ink-muted)]">
        {rep.email ?? <span className="italic">No Veeva email</span>}
      </td>
      <td className="px-4 py-3">
        {isProvisioned ? (
          <span className="text-xs rounded px-2 py-0.5 bg-[var(--color-positive)]/15 text-[var(--color-positive-deep)]">
            Provisioned ({rep.provisioned_email})
          </span>
        ) : (
          <span className="text-xs rounded px-2 py-0.5 bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)] border border-[var(--color-border)]">
            No login
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        {isProvisioned ? null : (
          <form action={formAction} className="flex items-center gap-2">
            <input type="hidden" name="email" value={rep.email ?? ""} />
            <input type="hidden" name="tenant_slug" value={tenantSlug} />
            <input type="hidden" name="veeva_user_key" value={rep.user_key} />
            <select
              name="role"
              defaultValue="rep"
              disabled={isPending}
              className="px-2 py-1 rounded border border-[var(--color-border)] bg-white text-xs"
            >
              <option value="rep">Rep</option>
              <option value="manager">Manager</option>
            </select>
            <button
              type="submit"
              disabled={isPending || !hasEmail}
              title={
                hasEmail
                  ? "Send invite using the Veeva email"
                  : "No email on the Veeva user — use the manual invite form"
              }
              className="px-3 py-1 rounded bg-[var(--color-primary)] text-white text-xs hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
            >
              {isPending ? "Sending…" : "Invite"}
            </button>
          </form>
        )}
        {state.error ? (
          <p className="text-xs text-[var(--color-negative-deep)] mt-1">
            {state.error}
          </p>
        ) : null}
        {state.success ? (
          <p className="text-xs text-[var(--color-positive-deep)] mt-1">
            {state.success}
          </p>
        ) : null}
      </td>
    </tr>
  );
}
