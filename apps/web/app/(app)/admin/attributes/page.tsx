import { notFound } from "next/navigation";
import Link from "next/link";
import { db } from "@/lib/db";
import { asc, eq, schema } from "@throughline/db";
import { getCurrentScope } from "@/lib/scope";
import { listBronzeTablesForTenant } from "@/lib/bronze-introspection";
import AttributeForm from "./attribute-form";
import AttributeRow from "./attribute-row";

export const dynamic = "force-dynamic";

// /admin/attributes — Phase 1 of the tenant-custom HCP/HCO attributes
// architecture (docs/architecture/tenant-custom-attributes.md). This
// surface manages the `tenant_attribute_map` config table that tells
// the silver attribute builds (Phase 2, not yet built) which bronze
// columns are scoring/targeting attributes + their semantic shape.
//
// Until the silver/gold builds land in Phase 2, mappings declared
// here have no downstream effect — but admins can pre-configure for
// when ingestion ships. The plumbing is forward-compatible.

export default async function AdminAttributesPage() {
  const { resolution } = await getCurrentScope();
  if (
    !resolution?.ok ||
    (resolution.scope.role !== "admin" && resolution.scope.role !== "bypass")
  ) {
    notFound();
  }

  const isBypass = resolution.scope.role === "bypass";
  const allTenants = await db.select().from(schema.tenant);
  const tenantNameById = new Map(allTenants.map((t) => [t.id, t.name]));
  // Active tenant for the form context (admins: their own; bypass:
  // first tenant). The form's bronze pickers operate against this
  // tenant's bronze schema.
  const activeTenant =
    allTenants.find((t) => t.id === resolution.scope.tenantId) ??
    allTenants[0];

  const [mappings, bronzeTables] = await Promise.all([
    db
      .select()
      .from(schema.tenantAttributeMap)
      .where(
        isBypass
          ? undefined
          : eq(schema.tenantAttributeMap.tenantId, resolution.scope.tenantId),
      )
      .orderBy(
        asc(schema.tenantAttributeMap.entityType),
        asc(schema.tenantAttributeMap.attributeName),
      ),
    activeTenant
      ? listBronzeTablesForTenant(activeTenant.id, activeTenant.slug)
      : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/admin/tenants"
          className="text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          ← Admin
        </Link>
        <h1 className="font-display text-[28px] leading-[1.2] tracking-tight mt-2">Attributes</h1>
        <p className="text-[var(--color-ink-muted)]">
          Per-tenant HCP/HCO scoring attribute mappings (Komodo deciles,
          Clarivate volumes, etc.). Phase 1: config plumbing — silver +
          gold builds + LLM input wiring ship in subsequent phases. See{" "}
          <code className="text-xs">docs/architecture/tenant-custom-attributes.md</code>.
        </p>
      </div>

      <AttributeForm bronzeTables={bronzeTables} />

      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-baseline justify-between gap-4">
          <div>
            <h2 className="font-display text-lg">Configured mappings</h2>
            <p className="text-xs text-[var(--color-ink-muted)]">
              {mappings.length} mapping{mappings.length === 1 ? "" : "s"}{" "}
              {isBypass ? "across all tenants" : "for this tenant"}.
            </p>
          </div>
        </div>
        {mappings.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-[var(--color-ink-muted)] italic">
            No attribute mappings configured yet. Add one above to declare
            a bronze column as a scoring attribute.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-[var(--color-ink-muted)] border-b border-[var(--color-border)]">
              <tr>
                {isBypass ? (
                  <th className="text-left font-normal px-4 py-2">Tenant</th>
                ) : null}
                <th className="text-left font-normal px-4 py-2">Entity</th>
                <th className="text-left font-normal px-4 py-2">
                  Attribute name
                </th>
                <th className="text-left font-normal px-4 py-2">Type</th>
                <th className="text-left font-normal px-4 py-2">Source</th>
                <th className="text-left font-normal px-4 py-2">Bronze ref</th>
                <th className="text-left font-normal px-4 py-2">Source label</th>
                <th className="text-left font-normal px-4 py-2">Scope tag</th>
                <th className="text-left font-normal px-4 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {mappings.map((m) => (
                <tr
                  key={m.id}
                  className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-alt)]/40"
                >
                  {isBypass ? (
                    <td className="px-4 py-2 text-[var(--color-ink-muted)]">
                      {tenantNameById.get(m.tenantId) ?? m.tenantId}
                    </td>
                  ) : null}
                  <td className="px-4 py-2 uppercase text-xs">
                    {m.entityType}
                  </td>
                  <td className="px-4 py-2 font-medium">{m.attributeName}</td>
                  <td className="px-4 py-2 text-[var(--color-ink-muted)]">
                    {m.attributeType}
                  </td>
                  <td className="px-4 py-2 text-[var(--color-ink-muted)]">
                    {m.sourceSystem}
                  </td>
                  <td className="px-4 py-2 text-xs font-mono text-[var(--color-ink-muted)]">
                    {m.bronzeTable}.{m.bronzeColumn}
                  </td>
                  <td className="px-4 py-2 text-[var(--color-ink-muted)]">
                    {m.sourceLabel}
                  </td>
                  <td className="px-4 py-2 text-[var(--color-ink-muted)]">
                    {m.scopeTag ?? "—"}
                  </td>
                  <td className="px-4 py-2">
                    <AttributeRow id={m.id} active={m.active} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="rounded-lg bg-[var(--color-surface-alt)]/40 border border-[var(--color-border)] p-4 text-xs text-[var(--color-ink-muted)]">
        <p className="font-medium text-[var(--color-ink)] mb-1">
          Phase 2 follow-ups (not yet built)
        </p>
        <ul className="list-disc pl-5 space-y-0.5">
          <li>
            <code>silver_hcp_attribute_build</code> + <code>silver_hco_attribute_build</code>{" "}
            notebooks — read this config, pivot bronze columns into long-format silver
          </li>
          <li>
            <code>gold.dim_hcp_attribute</code> + <code>gold.dim_hcp_score_wide</code>{" "}
            (pivot of common scoring attributes for fast joins)
          </li>
          <li>
            <code>gold.hcp_target_score</code> — composite "should-call" score
            blending these attributes with our derived signals; consumed by the
            <code>predictions.hcp_target_scores</code> field on rep-recommendation input
          </li>
          <li>
            Add <code>tenant_attribute_map</code> to the <code>config_sync</code> notebook
            so Fabric mirrors stay current
          </li>
        </ul>
      </div>
    </div>
  );
}
