import { notFound } from "next/navigation";
import Link from "next/link";
import { getCurrentScope } from "@/lib/scope";
import {
  loadUnmappedAccounts,
  loadSavedAccountMappings,
  loadLastMappingPipelineRun,
  SAVED_MAPPINGS_LOAD_CAP,
} from "./load";
import { suggestForUnmapped } from "@/lib/mapping-suggestions";
import AccountMappingRow from "./account-mapping-row";
import CsvSection from "./csv-section";
import SavedMappingsList from "./saved-mappings-list";
import PipelineTrigger from "./pipeline-trigger";

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

  const [unmappedRaw, saved, lastPipelineRun] = await Promise.all([
    loadUnmappedAccounts(tenantId),
    loadSavedAccountMappings(tenantId),
    loadLastMappingPipelineRun(tenantId),
  ]);

  // Architectural rule: Postgres is authoritative for admin-edited state,
  // Fabric mirrors are sync-lagged. unmappedRaw comes from gold.fact_sale
  // where account_key IS NULL — but that join hasn't been refreshed since
  // the most recent mapping save. Subtract anything already saved in
  // Postgres so the admin sees instant feedback after upload / per-row
  // save, instead of waiting on the silver_account_xref + gold_fact_sale
  // rebuild. (See feedback memory: postgres_authoritative_for_admin_edits.)
  const savedSourceKeys = new Set(saved.rows.map((m) => m.sourceKey));
  const unmappedFiltered = unmappedRaw.filter(
    (u) => !savedSourceKeys.has(u.distributor_account_id),
  );
  // Display cap matches the previous Fabric TOP 100 behavior. Buffer above
  // (TOP 500) keeps this populated even when the top-of-row-count rows
  // were just mapped.
  const unmapped = unmappedFiltered.slice(0, 100);
  const moreThanShown = unmappedFiltered.length > unmapped.length;

  // Compute fuzzy suggestions per unmapped distributor (state-filtered name
  // similarity + city/postal bonus). Cheap in-memory pass after one batched
  // query of HCP+HCO names for the relevant states. Returns Map<id,
  // SuggestionCandidate[]>; rows with no good suggestion get nothing.
  const suggestions = await suggestForUnmapped(tenantId, unmapped);

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
        <h1 className="font-display text-[28px] leading-[1.2] tracking-tight mt-2">Mappings</h1>
        <p className="text-[var(--color-ink-muted)]">
          Map distributor account IDs to Veeva accounts so sales rows resolve
          to the right HCP/HCO and roll up by territory.
        </p>
      </div>

      <CsvSection />

      <PipelineTrigger lastRun={lastPipelineRun} />

      {/* Primary surface: unmapped accounts that need attention */}
      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--color-border)]">
          <h2 className="font-display text-xl">Needs mapping</h2>
          <p className="text-xs text-[var(--color-ink-muted)]">
            Distributor accounts in sales data without a Veeva mapping yet.
            Most-active first. Reflects saves made on this page immediately;
            sales-side resolution refreshes on the next pipeline run.
            {unmapped.length > 0 ? (
              <span className="ml-2 text-[var(--color-ink)]">
                {unmapped.length}
                {moreThanShown ? "+" : ""} unmapped
              </span>
            ) : null}
          </p>
        </div>
        {unmapped.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-[var(--color-ink-muted)] italic">
            No unmapped accounts. Either everything is mapped, or
            <span className="font-mono not-italic"> gold.fact_sale</span> hasn&apos;t been
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
                <AccountMappingRow
                  key={u.distributor_account_id}
                  row={u}
                  suggestions={suggestions.get(u.distributor_account_id) ?? []}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <SavedMappingsList
        rows={saved.rows}
        totalCount={saved.total}
        loadCap={SAVED_MAPPINGS_LOAD_CAP}
      />

    </div>
  );
}
