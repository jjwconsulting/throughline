import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { eq, desc, schema } from "@throughline/db";
import { getCurrentScope } from "@/lib/scope";
import InviteForm from "./invite-form";
import RepInviteRow from "./rep-invite-row";
import { loadVeevaRepsForInvite } from "./veeva-reps";

export const dynamic = "force-dynamic";

export default async function AdminUsersPage() {
  // Gate: only admin or bypass can manage users.
  const { resolution } = await getCurrentScope();
  if (
    !resolution?.ok ||
    (resolution.scope.role !== "admin" && resolution.scope.role !== "bypass")
  ) {
    notFound();
  }

  const allTenants = await db.select().from(schema.tenant);
  const tenants =
    resolution.scope.role === "bypass"
      ? allTenants
      : allTenants.filter((t) => t.id === resolution.scope.tenantId);

  // For admins, the active tenant context — used to seed the Veeva reps panel
  // and the hidden tenant_slug on each per-row form. For bypass users (who can
  // span tenants) the panel only renders for tenants they pick into; v1 just
  // shows the first tenant. Fancier multi-tenant view comes later.
  const activeTenant = tenants[0];

  const [veevaReps, userRows] = await Promise.all([
    activeTenant
      ? loadVeevaRepsForInvite(activeTenant.id)
      : Promise.resolve([]),
    db
      .select({
        tenantId: schema.tenantUser.tenantId,
        userEmail: schema.tenantUser.userEmail,
        role: schema.tenantUser.role,
        veevaUserKey: schema.tenantUser.veevaUserKey,
        updatedAt: schema.tenantUser.updatedAt,
      })
      .from(schema.tenantUser)
      .where(
        resolution.scope.role === "bypass"
          ? undefined
          : eq(schema.tenantUser.tenantId, resolution.scope.tenantId),
      )
      .orderBy(desc(schema.tenantUser.updatedAt)),
  ]);

  const tenantNameById = new Map(allTenants.map((t) => [t.id, t.name]));

  const repsToInvite = veevaReps.filter((r) => !r.provisioned);
  const repsAlready = veevaReps.length - repsToInvite.length;

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
            href="/admin/goals"
            className="text-[var(--color-primary)] hover:underline"
          >
            Goals →
          </Link>
        </div>
        <h1 className="font-display text-[28px] leading-[1.2] tracking-tight mt-2">Users</h1>
        <p className="text-[var(--color-ink-muted)]">
          Invite users with their tenant + role pre-set. Clerk sends the
          email; the webhook provisions a tenant_user row when they accept.
        </p>
      </div>

      {/* Primary path: invite from Veeva data we already have. */}
      {activeTenant ? (
        <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
          <div className="px-5 py-4 border-b border-[var(--color-border)]">
            <h2 className="font-display text-xl">Invite from Veeva</h2>
            <p className="text-xs text-[var(--color-ink-muted)]">
              Active field reps from{" "}
              <span className="font-mono">gold.dim_user</span> for{" "}
              {activeTenant.name}.{" "}
              {repsAlready > 0
                ? `${repsAlready} already provisioned, ${repsToInvite.length} to go.`
                : `${veevaReps.length} reps total.`}
            </p>
          </div>
          {veevaReps.length === 0 ? (
            <div className="px-5 py-8 text-center text-sm text-[var(--color-ink-muted)] italic">
              No active field reps in <span className="font-mono not-italic">gold.dim_user</span>.
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)]">
                <tr>
                  <th className="text-left px-4 py-2 font-normal">Rep</th>
                  <th className="text-left px-4 py-2 font-normal">Email</th>
                  <th className="text-left px-4 py-2 font-normal">Status</th>
                  <th className="text-left px-4 py-2 font-normal">Action</th>
                </tr>
              </thead>
              <tbody>
                {veevaReps.map((rep) => (
                  <RepInviteRow
                    key={rep.user_key}
                    rep={rep}
                    tenantSlug={activeTenant.slug}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}

      {/* Escape hatch: manual invite for non-rep roles or reps without a Veeva email. */}
      <details className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-6">
        <summary className="cursor-pointer">
          <span className="font-display text-xl">Manual invite</span>
          <span className="ml-3 text-xs text-[var(--color-ink-muted)]">
            For admins, managers, or reps without a Veeva email
          </span>
        </summary>
        <div className="mt-4">
          <InviteForm tenants={tenants} />
        </div>
      </details>

      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--color-border)]">
          <h2 className="font-display text-xl">Provisioned users</h2>
          <p className="text-xs text-[var(--color-ink-muted)]">
            Rows in <span className="font-mono">tenant_user</span>. Created by
            the webhook on user creation/update.
          </p>
        </div>
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)]">
            <tr>
              <th className="text-left px-4 py-2 font-normal">Email</th>
              <th className="text-left px-4 py-2 font-normal">Tenant</th>
              <th className="text-left px-4 py-2 font-normal">Role</th>
              <th className="text-left px-4 py-2 font-normal">Veeva user_key</th>
              <th className="text-left px-4 py-2 font-normal">Updated</th>
            </tr>
          </thead>
          <tbody>
            {userRows.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-5 py-8 text-center text-sm text-[var(--color-ink-muted)] italic"
                >
                  No users provisioned yet.
                </td>
              </tr>
            ) : (
              userRows.map((u) => (
                <tr
                  key={`${u.tenantId}-${u.userEmail}`}
                  className="border-t border-[var(--color-border)]"
                >
                  <td className="px-4 py-2">{u.userEmail}</td>
                  <td className="px-4 py-2 text-[var(--color-ink-muted)]">
                    {tenantNameById.get(u.tenantId) ?? u.tenantId}
                  </td>
                  <td className="px-4 py-2">{u.role}</td>
                  <td className="px-4 py-2 font-mono text-xs text-[var(--color-ink-muted)]">
                    {u.veevaUserKey ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-[var(--color-ink-muted)]">
                    {u.updatedAt.toISOString().slice(0, 10)}
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
