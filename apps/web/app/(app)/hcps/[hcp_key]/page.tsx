import { notFound } from "next/navigation";
import Link from "next/link";
import { queryFabric } from "@/lib/fabric";
import {
  loadInteractionKpis,
  loadTrend,
  hcpScope,
  type Scope,
} from "@/lib/interactions";
import { loadAllScoresForHcp } from "@/lib/hcp-target-scores";
import {
  loadSinceLastVisit,
  loadPeerCohort,
} from "@/lib/hcp-page-insights";
import { getCurrentScope, scopeToSql, combineScopes } from "@/lib/scope";
import { db } from "@/lib/db";
import { eq, schema } from "@throughline/db";
import TargetScoreCard from "@/components/target-score-card";
import HcpSnapshotCard from "@/components/hcp-snapshot-card";
import PeerCohortCard from "@/components/peer-cohort-card";
import {
  filterClauses,
  filtersToParams,
  parseFilters,
  chartBuckets,
  GRANULARITY_LABELS,
  periodLabel,
  type DashboardFilters,
} from "../../dashboard/filters";
import TrendChart from "../../dashboard/trend-chart";
import FilterBar from "../../dashboard/filter-bar";

export const dynamic = "force-dynamic";

type HcpHeader = {
  hcp_key: string;
  name: string;
  credentials: string | null;
  specialty_primary: string | null;
  specialty_secondary: string | null;
  city: string | null;
  state: string | null;
  npi: string | null;
  tier: string | null;
  is_prescriber: boolean | null;
  is_kol: boolean | null;
  is_speaker: boolean | null;
  status: string | null;
  primary_parent_hco_key: string | null;
  primary_parent_hco_name: string | null;
  // CRM record id — needed for Veeva deep links from the snapshot.
  veeva_account_id: string | null;
};

async function loadHcp(
  tenantId: string,
  hcpKey: string,
): Promise<HcpHeader | null> {
  const rows = await queryFabric<HcpHeader>(
    tenantId,
    `SELECT TOP 1
       hcp_key, name, credentials, specialty_primary, specialty_secondary,
       city, state, npi, tier, is_prescriber, is_kol, is_speaker, status,
       primary_parent_hco_key, primary_parent_hco_name,
       veeva_account_id
     FROM gold.dim_hcp
     WHERE tenant_id = @tenantId AND hcp_key = @hcpKey`,
    { hcpKey },
  );
  return rows[0] ?? null;
}

// Last-ever call date (filter-independent). The KPI card's
// `last_contact` is filter-scoped — for the snapshot's engagement
// status we want overall HCP recency regardless of the page's range
// filter.
async function loadLastCallEver(
  tenantId: string,
  hcpKey: string,
): Promise<string | null> {
  try {
    const rows = await queryFabric<{ last_call: string | null }>(
      tenantId,
      `SELECT CONVERT(varchar(10), MAX(call_date), 23) AS last_call
       FROM gold.fact_call
       WHERE tenant_id = @tenantId AND hcp_key = @hcpKey`,
      { hcpKey },
    );
    return rows[0]?.last_call ?? null;
  } catch (err) {
    console.error("loadLastCallEver failed:", err);
    return null;
  }
}

// HCP page-specific: which reps called this HCP. Not generalizable enough
// to live in lib/interactions.ts (different SELECT shape, includes title +
// last_call per rep), so it stays here.
type CallingRep = {
  user_key: string;
  name: string;
  title: string | null;
  calls: number;
  last_call: string | null;
};

async function loadHcpCallingReps(
  tenantId: string,
  filters: DashboardFilters,
  scope: Scope,
): Promise<CallingRep[]> {
  const { dateFilter, channelFilter, callKindFilter } = filterClauses(filters);
  return queryFabric<CallingRep>(
    tenantId,
    `SELECT TOP 10 u.user_key, u.name, u.title,
       COUNT(*) AS calls,
       CONVERT(varchar(10), MAX(f.call_date), 23) AS last_call
     FROM gold.fact_call f
     JOIN gold.dim_user u ON u.user_key = f.owner_user_key AND u.tenant_id = @tenantId
     WHERE f.tenant_id = @tenantId
       ${dateFilter} ${channelFilter} ${callKindFilter} ${scope.clauses.join(" ")}
     GROUP BY u.user_key, u.name, u.title
     ORDER BY calls DESC`,
    { ...filtersToParams(filters), ...scope.params },
  );
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// daysSince + deltaLabel removed — only used by the now-deleted KPI
// cards array. HcpSnapshotCard owns equivalent display logic now.

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type RouteParams = Promise<{ hcp_key: string }>;

export default async function HcpDetail({
  params,
  searchParams,
}: {
  params: RouteParams;
  searchParams: SearchParams;
}) {
  const { hcp_key } = await params;
  const filters = parseFilters(await searchParams);

  const { resolution } = await getCurrentScope();
  if (!resolution || !resolution.ok) notFound();
  const { scope: userScope } = resolution;
  const tenantId = userScope.tenantId;

  const hcp = await loadHcp(tenantId, hcp_key);
  if (!hcp) notFound();

  // HCP entity itself is shared across the tenant — anyone in the tenant
  // can see this HCP's name, specialty, etc. But the call data we render
  // is RLS-scoped: a rep only sees calls THEY made to this HCP, a manager
  // sees calls their team made, etc.
  const sqlScope = combineScopes(hcpScope(hcp_key), scopeToSql(userScope));
  // Viewer's user_key is only meaningful when the viewer IS a rep —
  // anchors the "Since your last visit" panel on their own most recent
  // call. Manager/admin/bypass viewers fall back to tenant-wide
  // most-recent call as the anchor (handled by the loader).
  const viewerUserKey =
    userScope.role === "rep" ? userScope.userKey : null;
  const [
    kpis,
    trend,
    callingReps,
    scores,
    sinceLastVisit,
    peerCohort,
    lastCallEver,
    tenantVeevaRows,
  ] = await Promise.all([
    loadInteractionKpis(tenantId, filters, sqlScope),
    loadTrend(tenantId, filters, sqlScope),
    loadHcpCallingReps(tenantId, filters, sqlScope),
    // Targeting score is HCP-grain (not RLS-scoped — score is an
    // attribute of the HCP itself, same as tier/specialty above).
    loadAllScoresForHcp({ tenantId, hcpKey: hcp_key }),
    loadSinceLastVisit({ tenantId, hcpKey: hcp_key, viewerUserKey }),
    loadPeerCohort({ tenantId, hcpKey: hcp_key }),
    // Snapshot uses ALL-time last-call recency for engagement status,
    // so it isn't dependent on the page's range filter.
    loadLastCallEver(tenantId, hcp_key),
    // Vault domain for the snapshot's "Open in Veeva" deep link.
    db
      .select({ vaultDomain: schema.tenantVeeva.vaultDomain })
      .from(schema.tenantVeeva)
      .where(eq(schema.tenantVeeva.tenantId, tenantId))
      .limit(1),
  ]);
  const vaultDomain = tenantVeevaRows[0]?.vaultDomain ?? null;

  const period = periodLabel(filters.range);
  // Removed: 3-col KPI cards array (Interactions / Reps engaged /
  // Last contact). These metrics moved into HcpSnapshotCard's 4-stat
  // grid per design review §1B (item #5 in the punch list).

  const flags = [
    hcp.is_prescriber ? "Prescriber" : null,
    hcp.is_kol ? "KOL" : null,
    hcp.is_speaker ? "Speaker" : null,
  ].filter(Boolean) as string[];

  const subtitleBits = [
    hcp.credentials,
    hcp.specialty_primary,
    [hcp.city, hcp.state].filter(Boolean).join(", ") || null,
  ].filter(Boolean) as string[];

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/dashboard"
          className="text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          ← Dashboard
        </Link>
        <div className="mt-2 flex items-end justify-between gap-4 flex-wrap">
          <div>
            <h1 className="font-display text-[28px] leading-[1.2] tracking-tight">
              {hcp.name}
            </h1>
            <p className="text-[var(--color-ink-muted)] text-sm">
              {subtitleBits.join(" • ") || "—"}
              {hcp.primary_parent_hco_key && hcp.primary_parent_hco_name ? (
                <>
                  {" • "}
                  <Link
                    href={`/hcos/${encodeURIComponent(hcp.primary_parent_hco_key)}`}
                    className="text-[var(--color-primary)] hover:underline"
                  >
                    {hcp.primary_parent_hco_name}
                  </Link>
                </>
              ) : null}
              {hcp.npi ? (
                <>
                  {" • "}
                  <span className="font-mono">NPI {hcp.npi}</span>
                </>
              ) : null}
            </p>
            {flags.length > 0 || hcp.tier ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {hcp.tier ? (
                  <span className="text-xs rounded px-2 py-0.5 bg-[var(--color-accent)]/15 text-[var(--color-ink)]">
                    Tier {hcp.tier}
                  </span>
                ) : null}
                {flags.map((f) => (
                  <span
                    key={f}
                    className="text-xs rounded px-2 py-0.5 bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)] border border-[var(--color-border)]"
                  >
                    {f}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          <FilterBar filters={filters} />
        </div>
      </div>

      {/* OVERVIEW super-section — Snapshot + Calls trend. The
          "what matters about this HCP at a glance" layer. */}
      <section className="space-y-4 pt-2">
        <h2 className="h2-section">Overview</h2>

        <HcpSnapshotCard
          inputs={{
            scores,
            last_call_ever: lastCallEver,
            interactions_period: kpis.calls_period,
            reps_engaged: kpis.reps,
            since_last_visit: sinceLastVisit,
            veeva_account_id: hcp.veeva_account_id,
            vault_domain: vaultDomain,
            hcp_key: hcp_key,
            viewer_user_key: viewerUserKey,
          }}
        />

        <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
          <div className="px-5 py-4 border-b border-[var(--color-border)]">
            <h3 className="font-display text-lg">
              Calls — {GRANULARITY_LABELS[filters.granularity].toLowerCase()}
            </h3>
            <p className="text-xs text-[var(--color-ink-muted)]">
              {chartBuckets(filters)} most recent {filters.granularity}
              {chartBuckets(filters) === 1 ? "" : "s"} for {hcp.name}
            </p>
          </div>
          <div className="px-2 py-4">
            <TrendChart data={trend} />
          </div>
        </div>
      </section>

      {/* DETAIL super-section — progressive-disclosure expanders for
          users who want to drill in. Per design review §1B: only ~30%
          of users care about Score breakdown / Peer cohort on any
          given visit, so default-collapse them. "Reps who've called"
          is default-open since it's the most-used detail. */}
      <section className="space-y-4 pt-6 border-t border-[var(--color-border)]">
        <h2 className="h2-section">Detail</h2>

        <details className="group rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
          <summary className="px-5 py-4 cursor-pointer flex items-center justify-between gap-4 list-none hover:bg-[var(--color-surface-alt)]">
            <h3 className="font-display text-lg">Score breakdown</h3>
            <ChevronDown />
          </summary>
          <div className="px-0 pb-0">
            <TargetScoreCard scores={scores} />
          </div>
        </details>

        <details className="group rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
          <summary className="px-5 py-4 cursor-pointer flex items-center justify-between gap-4 list-none hover:bg-[var(--color-surface-alt)]">
            <h3 className="font-display text-lg">Compared to similar HCPs</h3>
            <ChevronDown />
          </summary>
          <div className="px-0 pb-0">
            <PeerCohortCard data={peerCohort} />
          </div>
        </details>

        <details
          open
          className="group rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden"
        >
          <summary className="px-5 py-4 cursor-pointer flex items-center justify-between gap-4 list-none hover:bg-[var(--color-surface-alt)] border-b border-[var(--color-border)]">
            <div>
              <h3 className="font-display text-lg">Reps who&apos;ve called</h3>
              <p className="text-xs text-[var(--color-ink-muted)]">
                By calls in {period}
              </p>
            </div>
            <ChevronDown />
          </summary>
          <table className="w-full text-sm">
            <thead className="text-xs text-[var(--color-ink-muted)]">
              <tr>
                <th className="text-left font-normal px-5 py-2 w-8">#</th>
                <th className="text-left font-normal px-5 py-2">Rep</th>
                <th className="text-left font-normal px-5 py-2">Title</th>
                <th className="text-left font-normal px-5 py-2">Last call</th>
                <th className="text-right font-normal px-5 py-2">Calls</th>
              </tr>
            </thead>
            <tbody>
              {callingReps.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-5 py-8 text-center text-sm text-[var(--color-ink-muted)] italic"
                  >
                    No calls in this period.
                  </td>
                </tr>
              ) : (
                callingReps.map((r, i) => (
                  <tr
                    key={r.user_key}
                    className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-alt)]"
                  >
                    <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                      {i + 1}
                    </td>
                    <td className="px-5 py-2">
                      <Link
                        href={`/reps/${encodeURIComponent(r.user_key)}`}
                        className="text-[var(--color-primary)] hover:underline"
                      >
                        {r.name}
                      </Link>
                    </td>
                    <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                      {r.title ?? "—"}
                    </td>
                    <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                      {formatDate(r.last_call)}
                    </td>
                    <td className="px-5 py-2 text-right font-mono">
                      {formatNumber(r.calls)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </details>
      </section>
    </div>
  );
}

function ChevronDown() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      className="w-4 h-4 text-[var(--color-ink-muted)] transition-transform group-open:rotate-180"
      aria-hidden="true"
    >
      <path
        fillRule="evenodd"
        d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
        clipRule="evenodd"
      />
    </svg>
  );
}
