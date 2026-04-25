import { notFound } from "next/navigation";
import Link from "next/link";
import { getCurrentScope } from "@/lib/scope";
import {
  loadUnmappedAccounts,
  loadSavedAccountMappings,
} from "./load";
import AccountMappingRow from "./account-mapping-row";

export const dynamic = "force-dynamic";

export default async function AdminMappingsPage() {
  const { resolution } = await getCurrentScope();
  if (
    !resolution?.ok ||
    (resolution.scope.role !== "admin" && resolution.scope.role !== "bypass")
  ) {
    notFound();
  }
  const tenantId = resolution.scope.tenantId;

  const [unmapped, saved] = await Promise.all([
    loadUnmappedAccounts(tenantId),
    loadSavedAccountMappings(tenantId),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3 text-xs">
          <Link
            href="/admin/tenants"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            ← Tenants
          </Link>
          <span className="text-[var(--color-ink-muted)]">·</span>
          <Link
            href="/admin/users"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            Users
          </Link>
          <span className="text-[var(--color-ink-muted)]">·</span>
          <Link
            href="/admin/goals"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            Goals
          </Link>
        </div>
        <h1 className="font-display text-3xl mt-2">Mappings</h1>
        <p className="text-[var(--color-ink-muted)]">
          Map distributor account IDs to Veeva accounts so sales rows resolve
          to the right HCP/HCO and roll up by territory.
        </p>
      </div>

      {/* Primary surface: unmapped accounts that need attention */}
      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--color-border)]">
          <h2 className="font-display text-xl">Needs mapping</h2>
          <p className="text-xs text-[var(--color-ink-muted)]">
            Distributor accounts in <span className="font-mono">gold.fact_sale</span>{" "}
            with no <span className="font-mono">account_xref</span> entry. Most-active
            first.
            {unmapped.length > 0 ? (
              <span className="ml-2 text-[var(--color-ink)]">
                {unmapped.length} unmapped
              </span>
            ) : null}
          </p>
        </div>
        {unmapped.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-[var(--color-ink-muted)]">
            No unmapped accounts. Either everything is mapped, or
            <span className="font-mono"> gold.fact_sale</span> hasn&apos;t been
            built yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)]">
              <tr>
                <th className="text-left px-4 py-2 font-normal">
                  Distributor ID
                </th>
                <th className="text-left px-4 py-2 font-normal">Account</th>
                <th className="text-right px-4 py-2 font-normal">Rows</th>
                <th className="text-right px-4 py-2 font-normal">
                  Net gross $
                </th>
                <th className="text-right px-4 py-2 font-normal">Last seen</th>
                <th className="text-left px-4 py-2 font-normal w-32">Action</th>
              </tr>
            </thead>
            <tbody>
              {unmapped.map((u) => (
                <AccountMappingRow key={u.distributor_account_id} row={u} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Saved mappings — audit / reference */}
      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--color-border)]">
          <h2 className="font-display text-xl">Saved mappings</h2>
          <p className="text-xs text-[var(--color-ink-muted)]">
            Postgres <span className="font-mono">mapping</span> table where{" "}
            <span className="font-mono">kind = &apos;account_xref&apos;</span>.
            These mirror to Fabric on the next{" "}
            <span className="font-mono">config_sync</span> run.
          </p>
        </div>
        {saved.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-[var(--color-ink-muted)]">
            No mappings saved yet.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)]">
              <tr>
                <th className="text-left px-4 py-2 font-normal">
                  Distributor ID
                </th>
                <th className="text-left px-4 py-2 font-normal">
                  Veeva account ID
                </th>
                <th className="text-left px-4 py-2 font-normal">Notes</th>
                <th className="text-left px-4 py-2 font-normal">Updated</th>
                <th className="text-left px-4 py-2 font-normal">By</th>
              </tr>
            </thead>
            <tbody>
              {saved.map((m) => (
                <tr
                  key={m.id}
                  className="border-t border-[var(--color-border)]"
                >
                  <td className="px-4 py-2 font-mono text-xs">{m.sourceKey}</td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {m.targetValue}
                  </td>
                  <td className="px-4 py-2 text-[var(--color-ink-muted)]">
                    {m.notes ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-[var(--color-ink-muted)]">
                    {m.updatedAt.toISOString().slice(0, 10)}
                  </td>
                  <td className="px-4 py-2 text-[var(--color-ink-muted)]">
                    {m.updatedBy}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-lg border border-[var(--color-border)] p-4 text-xs text-[var(--color-ink-muted)]">
        <strong className="text-[var(--color-ink)]">After saving mappings:</strong>{" "}
        Run <span className="font-mono">config_sync</span> →{" "}
        <span className="font-mono">silver_account_xref_build</span> →{" "}
        <span className="font-mono">gold_fact_sale_build</span> in Fabric to
        propagate the mapping into <span className="font-mono">gold.fact_sale</span>.
        Until then the dashboard&apos;s sales views still show the rows as
        unmapped. Pipeline-trigger automation is on the roadmap.
      </div>
    </div>
  );
}
