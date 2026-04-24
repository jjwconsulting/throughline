import Link from "next/link";
import { db } from "@/lib/db";
import { desc, schema } from "@throughline/db";
import TenantForm from "./tenant-form";

export const dynamic = "force-dynamic";

export default async function TenantsPage() {
  const tenants = await db
    .select()
    .from(schema.tenant)
    .orderBy(desc(schema.tenant.createdAt));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl">Tenants</h1>
        <p className="text-[var(--color-ink-muted)]">
          Each tenant gets its own bronze schema in Fabric. Shared silver + gold
          filter by tenant_id.
        </p>
        <p className="mt-2 text-sm">
          <Link
            href="/admin/users"
            className="text-[var(--color-primary)] hover:underline"
          >
            Manage users →
          </Link>
        </p>
      </div>

      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-6">
        <h2 className="font-display text-xl mb-4">Create tenant</h2>
        <TenantForm />
      </div>

      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)]">
            <tr>
              <th className="text-left px-4 py-2 font-normal">Slug</th>
              <th className="text-left px-4 py-2 font-normal">Name</th>
              <th className="text-left px-4 py-2 font-normal">Status</th>
              <th className="text-left px-4 py-2 font-normal">Created</th>
            </tr>
          </thead>
          <tbody>
            {tenants.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-8 text-center text-[var(--color-ink-muted)]"
                >
                  No tenants yet. Create one above.
                </td>
              </tr>
            ) : (
              tenants.map((t) => (
                <tr
                  key={t.id}
                  className="border-t border-[var(--color-border)]"
                >
                  <td className="px-4 py-2 font-mono">{t.slug}</td>
                  <td className="px-4 py-2">{t.name}</td>
                  <td className="px-4 py-2">{t.status}</td>
                  <td className="px-4 py-2 text-[var(--color-ink-muted)]">
                    {t.createdAt.toISOString().slice(0, 10)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
