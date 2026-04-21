"use client";

import { useActionState } from "react";
import { createTenantAction, type CreateTenantState } from "./actions";

const initialState: CreateTenantState = { error: null, success: false };

export default function TenantForm() {
  const [state, formAction, isPending] = useActionState(
    createTenantAction,
    initialState,
  );

  return (
    <form action={formAction} className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label
            htmlFor="slug"
            className="block text-sm text-[var(--color-ink-muted)] mb-1"
          >
            Slug
          </label>
          <input
            id="slug"
            name="slug"
            required
            pattern="^[a-z0-9-]{2,63}$"
            placeholder="acme-pharma"
            className="w-full px-3 py-2 rounded border border-[var(--color-border)] bg-white font-mono text-sm"
          />
          <p className="text-xs text-[var(--color-ink-muted)] mt-1">
            lowercase letters, digits, hyphens. Used as the Fabric bronze schema
            name.
          </p>
        </div>
        <div>
          <label
            htmlFor="name"
            className="block text-sm text-[var(--color-ink-muted)] mb-1"
          >
            Name
          </label>
          <input
            id="name"
            name="name"
            required
            placeholder="Acme Pharma"
            className="w-full px-3 py-2 rounded border border-[var(--color-border)] bg-white text-sm"
          />
        </div>
      </div>

      {state.error ? (
        <p className="text-sm text-[var(--color-negative)]">{state.error}</p>
      ) : null}
      {state.success ? (
        <p className="text-sm text-[var(--color-positive)]">Tenant created.</p>
      ) : null}

      <button
        type="submit"
        disabled={isPending}
        className="px-4 py-2 rounded bg-[var(--color-primary)] text-white text-sm hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
      >
        {isPending ? "Creating…" : "Create tenant"}
      </button>
    </form>
  );
}
