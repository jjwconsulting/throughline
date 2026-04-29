import { notFound } from "next/navigation";
import Link from "next/link";
import { queryFabric } from "@/lib/fabric";
import {
  loadInteractionKpis,
  loadTrend,
  loadTopHcps,
  repScope,
} from "@/lib/interactions";
import {
  loadRepSalesKpis,
  loadRepSalesTrend,
  loadRepTopHcos,
  loadRepCoverageHcos,
  loadRepCurrentTerritoryKeys,
} from "@/lib/sales";
import {
  getCurrentScope,
  scopeToSql,
  canSeeRep,
  combineScopes,
} from "@/lib/scope";
import { loadHcpInactivitySignals } from "@/lib/signals";
import {
  loadOverlappingGoalSum,
  attainmentLabel,
} from "@/lib/goal-lookup";
import SignalsPanel from "@/components/signals-panel";
import RepRecommendationsCard from "@/components/rep-recommendations-card";
import RepSnapshotCard from "@/components/rep-snapshot-card";
import CoverageHcosTable from "@/components/coverage-hcos-table";
import {
  loadRepRecommendations,
  loadRecommendationContexts,
  loadVeevaAccountIdsForItems,
  type RecommendationContext,
} from "@/lib/rep-recommendations";
import { db } from "@/lib/db";
import { eq, schema } from "@throughline/db";
import TrendChart from "../../dashboard/trend-chart";
import FilterBar from "../../dashboard/filter-bar";
import AccountToggle from "../../dashboard/account-toggle";
import {
  parseFilters,
  chartBuckets,
  GRANULARITY_LABELS,
  periodLabel,
  rangeDates,
} from "../../dashboard/filters";

export const dynamic = "force-dynamic";

type RepHeader = {
  user_key: string;
  name: string;
  title: string | null;
  department: string | null;
  user_type: string | null;
  status: string | null;
};

async function loadRep(
  tenantId: string,
  userKey: string,
): Promise<RepHeader | null> {
  const rows = await queryFabric<RepHeader>(
    tenantId,
    `SELECT TOP 1 user_key, name, title, department, user_type, status
     FROM gold.dim_user
     WHERE tenant_id = @tenantId AND user_key = @userKey`,
    { userKey },
  );
  return rows[0] ?? null;
}

// All-time last call by THIS rep (filter-independent). Used by
// RepSnapshotCard for engagement status — reflects rep activity
// regardless of the page's range filter.
async function loadLastCallEverByRep(
  tenantId: string,
  repUserKey: string,
): Promise<string | null> {
  try {
    const rows = await queryFabric<{ last_call: string | null }>(
      tenantId,
      `SELECT CONVERT(varchar(10), MAX(call_date), 23) AS last_call
       FROM gold.fact_call
       WHERE tenant_id = @tenantId AND owner_user_key = @repUserKey`,
      { repUserKey },
    );
    return rows[0]?.last_call ?? null;
  } catch (err) {
    console.error("loadLastCallEverByRep failed:", err);
    return null;
  }
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function daysSince(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const date = new Date(dateStr);
  const diff = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
  if (diff < 0) return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return `${diff} days ago`;
}

function formatDateLabel(dateStr: string | null): string | null {
  if (!dateStr) return null;
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function deltaLabel(current: number, prior: number): string | null {
  if (prior === 0) return null;
  const pct = ((current - prior) / prior) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}% vs prior period`;
}

function formatCompactDollars(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${Math.round(abs)}`;
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type RouteParams = Promise<{ user_key: string }>;

// Loads contexts for each recommendation in parallel, then renders the
// card with both items + contexts. Wrapped in its own server component
// so the dashboard's Promise.all doesn't have to wait for context
// queries — they fire only after recommendations land. Map → plain
// object for client-component serialization.
async function RecommendationsWithContext({
  tenantId,
  repUserKey,
  items,
  generatedAt,
  repFirstName,
}: {
  tenantId: string;
  repUserKey: string;
  items: import("@/lib/rep-recommendations").RepRecommendationItem[];
  generatedAt: Date;
  repFirstName: string;
}) {
  // Three batched lookups for the action-launchpad pattern:
  //  - contexts: per-row prep info (HCO/HCP context panel)
  //  - veeva account IDs: needed for "Open in Veeva" deep links
  //  - vault domain: per-tenant Veeva/Salesforce instance host
  // Vault domain comes from Postgres (tenant_veeva is admin-edited;
  // Postgres is authoritative per project_postgres_authoritative memory).
  const [ctxMap, veevaAccountIdByItemKey, tenantVeevaRows] = await Promise.all([
    loadRecommendationContexts({
      tenantId,
      repUserKey,
      items: items.map((i) => ({ kind: i.kind, key: i.key })),
    }),
    loadVeevaAccountIdsForItems({
      tenantId,
      items: items.map((i) => ({ kind: i.kind, key: i.key })),
    }),
    db
      .select({ vaultDomain: schema.tenantVeeva.vaultDomain })
      .from(schema.tenantVeeva)
      .where(eq(schema.tenantVeeva.tenantId, tenantId))
      .limit(1),
  ]);
  const contextByItemKey: Record<string, RecommendationContext> = {};
  for (const [k, v] of ctxMap.entries()) contextByItemKey[k] = v;
  const vaultDomain = tenantVeevaRows[0]?.vaultDomain ?? null;
  return (
    <RepRecommendationsCard
      items={items}
      contextByItemKey={contextByItemKey}
      veevaAccountIdByItemKey={veevaAccountIdByItemKey}
      vaultDomain={vaultDomain}
      repUserKey={repUserKey}
      generatedAt={generatedAt}
      repFirstName={repFirstName}
    />
  );
}

export default async function RepDetail({
  params,
  searchParams,
}: {
  params: RouteParams;
  searchParams: SearchParams;
}) {
  const { user_key } = await params;
  const filters = parseFilters(await searchParams);

  const { resolution } = await getCurrentScope();
  if (!resolution || !resolution.ok) notFound();
  const { scope } = resolution;
  const tenantId = scope.tenantId;

  // Don't leak existence of reps the current user can't see.
  if (!canSeeRep(scope, user_key)) notFound();

  const rep = await loadRep(tenantId, user_key);
  if (!rep) notFound();

  // Combine the page-specific scope (this rep's calls) with the RLS scope.
  // For a rep-role user, both clauses target owner_user_key — redundant
  // but harmless (they evaluate to the same row set).
  const sqlScope = combineScopes(repScope(user_key), scopeToSql(scope));
  const dateRange = rangeDates(filters.range);
  // "Effective units goal" = sum of overlapping territory-entity goal
  // portions for territories where this rep is the current primary rep.
  // Current-state only — see loadRepCurrentTerritoryKeys docstring for
  // the SCD2 limitation note.
  const effectiveUnitsGoalLookup = dateRange
    ? loadRepCurrentTerritoryKeys(tenantId, user_key).then((ids) =>
        loadOverlappingGoalSum({
          tenantId,
          metric: "units",
          entityType: "territory",
          entityFilter: { type: "in", ids },
          rangeStart: dateRange.start,
          rangeEnd: dateRange.end,
        }),
      )
    : Promise.resolve(null);
  const [
    kpis,
    trend,
    topHcps,
    inactivitySignals,
    proratedGoal,
    effectiveUnitsGoal,
    repSalesKpis,
    repSalesTrend,
    repTopHcosBySales,
    repCoverageHcos,
    recommendations,
    lastCallEverByRep,
  ] = await Promise.all([
      loadInteractionKpis(tenantId, filters, sqlScope),
      loadTrend(tenantId, filters, sqlScope),
      loadTopHcps(tenantId, filters, sqlScope),
      loadHcpInactivitySignals(tenantId, sqlScope),
      dateRange
        ? loadOverlappingGoalSum({
            tenantId,
            metric: "calls",
            entityType: "rep",
            entityFilter: { type: "single", id: user_key },
            rangeStart: dateRange.start,
            rangeEnd: dateRange.end,
          })
        : Promise.resolve(null),
      effectiveUnitsGoalLookup,
      loadRepSalesKpis(tenantId, user_key, filters),
      loadRepSalesTrend(tenantId, user_key, filters),
      loadRepTopHcos(tenantId, user_key, filters, 10),
      // Coverage list is current-state, not date-filtered. Cap at 200
      // for now; if reps cover hundreds we'll add a search/pagination.
      loadRepCoverageHcos(tenantId, user_key, 200),
      // LLM-generated "Suggested this week" — cached per (rep,
      // pipeline_run) with a 4h generation rate-limit. Same
      // narrator-over-input pattern as the dashboard synopsis.
      loadRepRecommendations({ tenantId, repUserKey: user_key }),
      // All-time last call (filter-independent) for snapshot engagement.
      loadLastCallEverByRep(tenantId, user_key),
    ]);

  const primaryCoverageCount = repCoverageHcos.filter(
    (c) => c.is_primary_for_rep === 1,
  ).length;

  const hasSalesHistory =
    repSalesKpis.last_sale != null ||
    repSalesKpis.net_gross_dollars_period !== 0 ||
    repSalesKpis.net_gross_dollars_prior !== 0;

  const period = periodLabel(filters.range);
  const interactionLabel =
    filters.account === "hcp"
      ? "HCP Interactions"
      : filters.account === "hco"
        ? "HCO Interactions"
        : "Interactions";
  const reachLabel =
    filters.account === "hco" ? "HCOs reached" : "HCPs reached";
  const reachValue =
    filters.account === "hco" ? "—" : formatNumber(kpis.hcps);

  // Prefer attainment as the secondary line when this rep has a goal for the
  // current period; fall back to vs-prior delta otherwise.
  const interactionsSecondary =
    proratedGoal != null && proratedGoal > 0
      ? attainmentLabel(kpis.calls_period, proratedGoal).label
      : filters.range === "all"
        ? null
        : deltaLabel(kpis.calls_period, kpis.calls_prior);
  const cards: { label: string; value: string; delta: string | null }[] = [
    {
      label: `${interactionLabel} (${period})`,
      value: formatNumber(kpis.calls_period),
      delta: interactionsSecondary,
    },
    { label: `${reachLabel} (${period})`, value: reachValue, delta: null },
    {
      label: "Last call",
      value: daysSince(kpis.last_call),
      delta: formatDateLabel(kpis.last_call),
    },
  ];
  if (hasSalesHistory) {
    const repSalesUnitsDelta =
      filters.range !== "all" && repSalesKpis.net_units_prior !== 0
        ? deltaLabel(
            repSalesKpis.net_units_period,
            repSalesKpis.net_units_prior,
          )
        : null;
    const repSalesDollarsLine =
      repSalesKpis.net_gross_dollars_period !== 0
        ? `${formatCompactDollars(repSalesKpis.net_gross_dollars_period)} net dollars`
        : null;
    // Attainment vs effective goal takes the primary slot when present
    // (matches Calls card behavior); dollars stays as supporting context;
    // delta drops off because attainment is itself a comparison.
    const repUnitsAttainment =
      effectiveUnitsGoal != null && effectiveUnitsGoal > 0
        ? attainmentLabel(
            Math.round(repSalesKpis.net_units_period),
            effectiveUnitsGoal,
          ).label
        : null;
    cards.push({
      label: `Net units (${period})`,
      value: formatNumber(Math.round(repSalesKpis.net_units_period)),
      delta: repUnitsAttainment
        ? repSalesDollarsLine
          ? `${repUnitsAttainment} · ${repSalesDollarsLine}`
          : repUnitsAttainment
        : repSalesDollarsLine && repSalesUnitsDelta
          ? `${repSalesDollarsLine} · ${repSalesUnitsDelta}`
          : repSalesDollarsLine ?? repSalesUnitsDelta,
    });
  }

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
            <h1 className="font-display text-[28px] leading-[1.2] tracking-tight">{rep.name}</h1>
            <p className="text-[var(--color-ink-muted)] text-sm">
              {[rep.title, rep.department, rep.user_type]
                .filter(Boolean)
                .join(" • ") || "—"}
              {rep.status && rep.status !== "Active" ? ` • ${rep.status}` : ""}
            </p>
          </div>
          <FilterBar filters={filters} />
        </div>
      </div>

      <RepSnapshotCard
        inputs={{
          calls_period: kpis.calls_period,
          calls_goal: proratedGoal,
          net_units_period: repSalesKpis.net_units_period,
          units_goal: effectiveUnitsGoal,
          coverage_hco_count: repCoverageHcos.length,
          primary_coverage_hco_count: primaryCoverageCount,
          last_call_ever: lastCallEverByRep,
        }}
      />

      <div className="space-y-3">
        <AccountToggle value={filters.account} />
        <div
          className={
            hasSalesHistory
              ? "grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4"
              : "grid grid-cols-1 md:grid-cols-3 gap-4"
          }
        >
          {cards.map((c) => (
            <div
              key={c.label}
              className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-5"
            >
              <p className="text-sm text-[var(--color-ink-muted)]">{c.label}</p>
              <p className="font-display text-3xl mt-2">{c.value}</p>
              {c.delta ? (
                <p className="text-xs text-[var(--color-ink-muted)] mt-1">
                  {c.delta}
                </p>
              ) : null}
            </div>
          ))}
        </div>
      </div>

      {recommendations.kind === "show" ? (
        <RecommendationsWithContext
          tenantId={tenantId}
          repUserKey={user_key}
          items={recommendations.items}
          generatedAt={recommendations.generatedAt}
          repFirstName={rep.name.split(" ")[0] ?? rep.name}
        />
      ) : null}

      {/* Trends pair — Calls + Net units side-by-side at lg+ so the
          rep can correlate calls vs sales passively. Mirrors
          /dashboard TRENDS pattern per design review punch list
          item #13. Net units cell only renders when this rep has
          sales history; otherwise Calls fills the row alone. */}
      <div
        className={
          hasSalesHistory
            ? "grid grid-cols-1 lg:grid-cols-2 gap-4"
            : ""
        }
      >
        <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
          <div className="px-5 py-4 border-b border-[var(--color-border)]">
            <h2 className="font-display text-lg">
              Calls — {GRANULARITY_LABELS[filters.granularity].toLowerCase()}
            </h2>
            <p className="text-xs text-[var(--color-ink-muted)]">
              {chartBuckets(filters)} most recent {filters.granularity}
              {chartBuckets(filters) === 1 ? "" : "s"} for {rep.name}
            </p>
          </div>
          <div className="px-2 py-4">
            <TrendChart
              data={trend}
              goalTotal={proratedGoal}
              paceUnitLabel={
                filters.granularity === "week"
                  ? "wk"
                  : filters.granularity === "month"
                    ? "mo"
                    : "qtr"
              }
            />
          </div>
        </div>

        {hasSalesHistory ? (
          <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
            <div className="px-5 py-4 border-b border-[var(--color-border)]">
              <h2 className="font-display text-lg">
                Net units — {GRANULARITY_LABELS[filters.granularity].toLowerCase()}
              </h2>
              <p className="text-xs text-[var(--color-ink-muted)]">
                Signed units (sales − returns), {chartBuckets(filters)}{" "}
                most recent {filters.granularity}
                {chartBuckets(filters) === 1 ? "" : "s"} attributed to {rep.name}
                {repSalesKpis.last_sale ? (
                  <> · last sale {formatDateLabel(repSalesKpis.last_sale)}</>
                ) : null}
              </p>
            </div>
            <div className="px-2 py-4">
              <TrendChart
                data={repSalesTrend}
                valueKey="net_units"
                valueLabel="Net units"
                format="number"
                goalTotal={effectiveUnitsGoal}
                paceUnitLabel={
                  filters.granularity === "week"
                    ? "wk"
                    : filters.granularity === "month"
                      ? "mo"
                      : "qtr"
                }
              />
            </div>
          </div>
        ) : null}
      </div>

      {hasSalesHistory ? (
        <>
          {repTopHcosBySales.length > 0 ? (
            <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
              <div className="px-5 py-4 border-b border-[var(--color-border)]">
                <h2 className="font-display text-lg">Top HCOs by Units</h2>
                <p className="text-xs text-[var(--color-ink-muted)]">
                  Top accounts in {period} for {rep.name}
                </p>
              </div>
              <table className="w-full text-sm">
                <thead className="text-xs text-[var(--color-ink-muted)]">
                  <tr>
                    <th className="text-left font-normal px-5 py-2 w-8">#</th>
                    <th className="text-left font-normal px-5 py-2">HCO</th>
                    <th className="text-left font-normal px-5 py-2">Type</th>
                    <th className="text-left font-normal px-5 py-2">Location</th>
                    <th className="text-right font-normal px-5 py-2">Units</th>
                    <th className="text-right font-normal px-5 py-2">Net dollars</th>
                  </tr>
                </thead>
                <tbody>
                  {repTopHcosBySales.map((h, i) => (
                    <tr
                      key={h.hco_key}
                      className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-alt)]"
                    >
                      <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                        {i + 1}
                      </td>
                      <td className="px-5 py-2">
                        <Link
                          href={`/hcos/${encodeURIComponent(h.hco_key)}`}
                          className="text-[var(--color-primary)] hover:underline"
                        >
                          {h.name}
                        </Link>
                      </td>
                      <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                        {h.hco_type ?? "—"}
                      </td>
                      <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                        {[h.city, h.state].filter(Boolean).join(", ") || "—"}
                      </td>
                      <td className="px-5 py-2 text-right font-mono">
                        {formatNumber(Math.round(h.net_units))}
                      </td>
                      <td className="px-5 py-2 text-right font-mono text-[var(--color-ink-muted)]">
                        {formatCompactDollars(h.net_gross_dollars)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}

      {repCoverageHcos.length > 0 ? (
        <CoverageHcosTable hcos={repCoverageHcos} repName={rep.name} />
      ) : null}

      <SignalsPanel
        title="HCPs to re-engage"
        subtitle={`${rep.name.split(" ")[0]}'s engaged HCPs with no contact in 60+ days`}
        signals={inactivitySignals}
        emptyHint="No lapsed HCPs in this rep's coverage."
      />

      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
        <div className="px-5 py-4 border-b border-[var(--color-border)]">
          <h2 className="font-display text-lg">Top HCPs called</h2>
          <p className="text-xs text-[var(--color-ink-muted)]">
            By calls in {period}
          </p>
        </div>
        <table className="w-full text-sm">
          <thead className="text-xs text-[var(--color-ink-muted)]">
            <tr>
              <th className="text-left font-normal px-5 py-2 w-8">#</th>
              <th className="text-left font-normal px-5 py-2">HCP</th>
              <th className="text-left font-normal px-5 py-2">Specialty</th>
              <th className="text-right font-normal px-5 py-2">Calls</th>
            </tr>
          </thead>
          <tbody>
            {topHcps.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-5 py-8 text-center text-sm text-[var(--color-ink-muted)] italic"
                >
                  No calls in this period.
                </td>
              </tr>
            ) : (
              topHcps.map((h, i) => (
                <tr
                  key={h.hcp_key}
                  className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-alt)]"
                >
                  <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                    {i + 1}
                  </td>
                  <td className="px-5 py-2">
                    <Link
                      href={`/hcps/${encodeURIComponent(h.hcp_key)}`}
                      className="text-[var(--color-primary)] hover:underline"
                    >
                      {h.name}
                    </Link>
                  </td>
                  <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                    {h.specialty ?? "—"}
                  </td>
                  <td className="px-5 py-2 text-right font-mono">
                    {formatNumber(h.calls)}
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
