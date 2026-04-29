"use client";

import { useActionState } from "react";
import { inviteUserAction, type InviteUserState } from "./actions";

const initial: InviteUserState = { error: null, success: null };

type Tenant = { slug: string; name: string };

export default function InviteForm({ tenants }: { tenants: Tenant[] }) {
  const [state, formAction, isPending] = useActionState(
    inviteUserAction,
    initial,
  );

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label
            htmlFor="email"
            className="block text-sm text-[var(--color-ink-muted)] mb-1"
          >
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            required
            placeholder="rep@fennecpharma.com"
            className="w-full px-3 py-2 rounded border border-[var(--color-border)] bg-white text-sm"
          />
        </div>

        <div>
          <label
            htmlFor="tenant_slug"
            className="block text-sm text-[var(--color-ink-muted)] mb-1"
          >
            Tenant
          </label>
          <select
            id="tenant_slug"
            name="tenant_slug"
            required
            defaultValue=""
            className="w-full px-3 py-2 rounded border border-[var(--color-border)] bg-white text-sm"
          >
            <option value="" disabled>
              Select tenant…
            </option>
            {tenants.map((t) => (
              <option key={t.slug} value={t.slug}>
                {t.name} ({t.slug})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label
            htmlFor="role"
            className="block text-sm text-[var(--color-ink-muted)] mb-1"
          >
            Role
          </label>
          <select
            id="role"
            name="role"
            required
            defaultValue="rep"
            className="w-full px-3 py-2 rounded border border-[var(--color-border)] bg-white text-sm"
          >
            <option value="admin">Admin — sees everything in tenant</option>
            <option value="manager">Manager — sees their team</option>
            <option value="rep">Rep — sees only their own data</option>
            <option value="bypass">
              Bypass — internal (cross-tenant)
            </option>
          </select>
        </div>

        <div>
          <label
            htmlFor="veeva_user_key"
            className="block text-sm text-[var(--color-ink-muted)] mb-1"
          >
            Veeva user_key{" "}
            <span className="text-xs">(required for rep)</span>
          </label>
          <input
            id="veeva_user_key"
            name="veeva_user_key"
            placeholder="md5 hash from gold.dim_user.user_key"
            className="w-full px-3 py-2 rounded border border-[var(--color-border)] bg-white font-mono text-sm"
          />
          <p className="text-xs text-[var(--color-ink-muted)] mt-1">
            For reps + managers. Find it in the URL when viewing a rep on{" "}
            <span className="font-mono">/reps/[user_key]</span>.
          </p>
        </div>
      </div>

      {state.error ? (
        <p className="text-sm text-[var(--color-negative-deep)]">{state.error}</p>
      ) : null}
      {state.success ? (
        <p className="text-sm text-[var(--color-positive-deep)]">{state.success}</p>
      ) : null}

      <button
        type="submit"
        disabled={isPending}
        className="px-4 py-2 rounded bg-[var(--color-primary)] text-white text-sm hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
      >
        {isPending ? "Sending…" : "Send invite"}
      </button>
    </form>
  );
}
