import Link from "next/link";
import {
  loadInteractionKpis,
  loadTrend,
  loadTopReps,
  loadTopHcps,
  loadTopHcos,
} from "@/lib/interactions";
import {
  loadSalesKpis,
  loadSalesTrend,
  loadTopUnmappedDistributors,
  loadTopHcosBySales,
  loadTopRepsBySales,
  loadRepCurrentTerritoryKeys,
} from "@/lib/sales";
import { getCurrentScope, scopeToSql } from "@/lib/scope";
import { loadHcpInactivitySignals } from "@/lib/signals";
import {
  loadOverlappingGoalSum,
  attainmentLabel,
} from "@/lib/goal-lookup";
import SignalsPanel from "@/components/signals-panel";
import TrendChart from "./trend-chart";
import FilterBar from "./filter-bar";
import AccountToggle from "./account-toggle";
import NoAccess from "./no-access";
import {
  parseFilters,
  chartBuckets,
  periodLabel,
  rangeDates,
  GRANULARITY_LABELS,
} from "./filters";

export const dynamic = "force-dynamic";

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

// Compact dollars: $1.2M / $345K / $87. Used in sales KPIs + trend axis.
function formatCompactDollars(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${Math.round(abs)}`;
}

function deltaLabel(current: number, prior: number): string | null {
  if (prior === 0) return null;
  const pct = ((current - prior) / prior) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}% vs prior period`;
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function Dashboard({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const filters = parseFilters(await searchParams);
  const { userEmail, resolution } = await getCurrentScope();

  if (!resolution || !resolution.ok) {
    return <NoAccess email={userEmail} reason={resolution?.reason} />;
  }
  const { scope } = resolution;
  const tenantId = scope.tenantId;
  const rlsScope = scopeToSql(scope);

  // Top accounts: swap HCP table for HCO table when in HCO mode.
  const showHcos = filters.account === "hco";
  // Goal lookup applies only on the calls metric for now, and only when the
  // filter has a concrete date range (skip "all"). Sums all overlapping
  // goal portions for the window — handles 12w spanning Q1+Q2 correctly.
  const dateRange = rangeDates(filters.range);
  const goalLookup = dateRange
    ? loadOverlappingGoalSum({
        tenantId,
        metric: "calls",
        entityType: "rep",
        entityFilter:
          scope.role === "rep"
            ? { type: "single", id: scope.userKey }
            : { type: "all" },
        rangeStart: dateRange.start,
        rangeEnd: dateRange.end,
      })
    : Promise.resolve(null);
  // Units goal lookup: territory-entity (pharma standard). For a rep-role
  // user the "effective goal" sums goals on territories where they're the
  // current primary rep — same model as /reps/[user_key]. For admin /
  // manager / bypass we fall through to tenant-wide sum (mirrors the
  // calls-goal behavior; tightening manager scope is queued).
  const unitsGoalLookup = dateRange
    ? scope.role === "rep"
      ? loadRepCurrentTerritoryKeys(tenantId, scope.userKey).then((ids) =>
          loadOverlappingGoalSum({
            tenantId,
            metric: "units",
            entityType: "territory",
            entityFilter: { type: "in", ids },
            rangeStart: dateRange.start,
            rangeEnd: dateRange.end,
          }),
        )
      : loadOverlappingGoalSum({
          tenantId,
          metric: "units",
          entityType: "territory",
          entityFilter: { type: "all" },
          rangeStart: dateRange.start,
          rangeEnd: dateRange.end,
        })
    : Promise.resolve(null);

  const [
    kpis,
    trend,
    topReps,
    topHcps,
    topHcos,
    inactivitySignals,
    periodGoal,
    unitsPeriodGoal,
    salesKpis,
    salesTrend,
    topUnmapped,
    topHcosBySales,
    topRepsBySales,
  ] = await Promise.all([
    loadInteractionKpis(tenantId, filters, rlsScope),
    loadTrend(tenantId, filters, rlsScope),
    loadTopReps(tenantId, filters, rlsScope),
    showHcos
      ? Promise.resolve([])
      : loadTopHcps(tenantId, filters, rlsScope),
    showHcos
      ? loadTopHcos(tenantId, filters, rlsScope)
      : Promise.resolve([]),
    // Signals are NOT filter-scoped — they always reflect "what needs
    // attention right now," regardless of which time window the rest of
    // the dashboard is showing.
    loadHcpInactivitySignals(tenantId, rlsScope),
    goalLookup,
    unitsGoalLookup,
    // Sales loaders use the same RLS scope as calls now that fact_sale
    // has rep_user_key (Phase A). Reps see only their attributed sales;
    // managers see their team's; admins see all incl. unmapped/unattributed.
    loadSalesKpis(tenantId, filters, rlsScope),
    loadSalesTrend(tenantId, filters, rlsScope),
    loadTopUnmappedDistributors(tenantId, filters, 10),
    loadTopHcosBySales(tenantId, filters, 10, rlsScope),
    loadTopRepsBySales(tenantId, filters, 10, rlsScope),
  ]);

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
    filters.account === "hco" ? formatNumber(kpis.hcos) : formatNumber(kpis.hcps);
  // For the interactions card, prefer attainment as the secondary line when
  // a goal exists for this period; fall back to vs-prior delta otherwise.
  // Goals are the more decision-useful signal when they exist.
  const interactionsSecondary =
    periodGoal != null && periodGoal > 0
      ? attainmentLabel(kpis.calls_period, periodGoal).label
      : filters.range === "all"
        ? null
        : deltaLabel(kpis.calls_period, kpis.calls_prior);
  // Sales card: units headline + dollars sub-line. Reps/managers think
  // in units (vials, doses, treatment cycles); dollars are the
  // finance/exec lens. Both rendered.
  const salesDelta =
    filters.range !== "all" && salesKpis.net_units_prior !== 0
      ? deltaLabel(
          salesKpis.net_units_period,
          salesKpis.net_units_prior,
        )
      : null;
  const salesDollarsLine =
    salesKpis.net_gross_dollars_period !== 0
      ? `${formatCompactDollars(salesKpis.net_gross_dollars_period)} net dollars`
      : null;
  // Prefer attainment as the primary secondary-line piece when a units
  // goal exists for this period (matches the calls card behavior).
  // Dollars stays as the supporting context; delta drops off when goal
  // is present (attainment IS the comparison).
  const unitsAttainment =
    unitsPeriodGoal != null && unitsPeriodGoal > 0
      ? attainmentLabel(
          Math.round(salesKpis.net_units_period),
          unitsPeriodGoal,
        ).label
      : null;
  const salesSecondary = unitsAttainment
    ? salesDollarsLine
      ? `${unitsAttainment} · ${salesDollarsLine}`
      : unitsAttainment
    : salesDollarsLine && salesDelta
      ? `${salesDollarsLine} · ${salesDelta}`
      : salesDollarsLine ?? salesDelta;
  const cards: { label: string; value: string; delta: string | null }[] = [
    {
      label: `${interactionLabel} (${period})`,
      value: formatNumber(kpis.calls_period),
      delta: interactionsSecondary,
    },
    { label: `${reachLabel} (${period})`, value: reachValue, delta: null },
    { label: `Active reps (${period})`, value: formatNumber(kpis.reps), delta: null },
    {
      label: `Net units (${period})`,
      value: formatNumber(Math.round(salesKpis.net_units_period)),
      delta: salesSecondary,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-3xl">Dashboard</h1>
          <p className="text-[var(--color-ink-muted)]">
            Live from gold tables. Filters apply to all panels below.
          </p>
        </div>
        <FilterBar filters={filters} />
      </div>

      <div className="space-y-3">
        <AccountToggle value={filters.account} />
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
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

      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
        <div className="px-5 py-4 border-b border-[var(--color-border)]">
          <h2 className="font-display text-lg">
            Calls — {GRANULARITY_LABELS[filters.granularity].toLowerCase()}
          </h2>
          <p className="text-xs text-[var(--color-ink-muted)]">
            {chartBuckets(filters)} most recent {filters.granularity}
            {chartBuckets(filters) === 1 ? "" : "s"}
          </p>
        </div>
        <div className="px-2 py-4">
          <TrendChart
            data={trend}
            goalTotal={periodGoal}
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

      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-baseline justify-between gap-4 flex-wrap">
          <div>
            <h2 className="font-display text-lg">
              Net units — {GRANULARITY_LABELS[filters.granularity].toLowerCase()}
            </h2>
            <p className="text-xs text-[var(--color-ink-muted)]">
              Signed units (sales − returns), {chartBuckets(filters)}{" "}
              most recent {filters.granularity}
              {chartBuckets(filters) === 1 ? "" : "s"}
            </p>
          </div>
          {salesKpis.accounts_unmapped > 0 ? (
            <Link
              href="/admin/mappings"
              className="text-xs text-[var(--color-primary)] hover:underline"
            >
              {salesKpis.accounts_unmapped} unmapped distributor
              {salesKpis.accounts_unmapped === 1 ? "" : "s"} →
            </Link>
          ) : null}
        </div>
        <div className="px-2 py-4">
          <TrendChart
            data={salesTrend}
            valueKey="net_units"
            valueLabel="Net units"
            format="number"
            goalTotal={unitsPeriodGoal}
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

      <SignalsPanel
        title="HCPs to re-engage"
        subtitle={`Engaged previously, no contact in the last ${60} days`}
        signals={inactivitySignals}
        emptyHint="No lapsed HCPs in your scope. Either coverage is current or the data window is too narrow."
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
          <div className="px-5 py-4 border-b border-[var(--color-border)]">
            <h2 className="font-display text-lg">Top reps</h2>
            <p className="text-xs text-[var(--color-ink-muted)]">
              By calls in {period}
            </p>
          </div>
          <table className="w-full text-sm">
            <thead className="text-xs text-[var(--color-ink-muted)]">
              <tr>
                <th className="text-left font-normal px-5 py-2 w-8">#</th>
                <th className="text-left font-normal px-5 py-2">Rep</th>
                <th className="text-right font-normal px-5 py-2">Calls</th>
              </tr>
            </thead>
            <tbody>
              {topReps.map((r, i) => (
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
                  <td className="px-5 py-2 text-right font-mono">
                    {formatNumber(r.calls)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
          <div className="px-5 py-4 border-b border-[var(--color-border)]">
            <h2 className="font-display text-lg">
              {showHcos ? "Top HCOs" : "Top HCPs"}
            </h2>
            <p className="text-xs text-[var(--color-ink-muted)]">
              By calls in {period}
            </p>
          </div>
          {showHcos ? (
            <table className="w-full text-sm">
              <thead className="text-xs text-[var(--color-ink-muted)]">
                <tr>
                  <th className="text-left font-normal px-5 py-2 w-8">#</th>
                  <th className="text-left font-normal px-5 py-2">HCO</th>
                  <th className="text-left font-normal px-5 py-2">Type</th>
                  <th className="text-left font-normal px-5 py-2">Location</th>
                  <th className="text-right font-normal px-5 py-2">Calls</th>
                </tr>
              </thead>
              <tbody>
                {topHcos.map((h, i) => (
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
                      {formatNumber(h.calls)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
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
                {topHcps.map((h, i) => (
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
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {topHcosBySales.length > 0 ? (
        <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
          <div className="px-5 py-4 border-b border-[var(--color-border)]">
            <h2 className="font-display text-lg">Top HCOs by Units</h2>
            <p className="text-xs text-[var(--color-ink-muted)]">
              Net units in {period}. Unmapped distributor sales appear as
              their own line so totals always reconcile.
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
              {topHcosBySales.map((h, i) => {
                const isUnmapped = h.hco_key == null;
                return (
                  <tr
                    key={h.hco_key ?? "__unmapped__"}
                    className={
                      "border-t border-[var(--color-border)] hover:bg-[var(--color-surface-alt)] " +
                      (isUnmapped ? "bg-[var(--color-surface-alt)]/40" : "")
                    }
                  >
                    <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                      {i + 1}
                    </td>
                    <td className="px-5 py-2">
                      {isUnmapped ? (
                        <Link
                          href="/admin/mappings"
                          className="text-[var(--color-ink-muted)] italic hover:text-[var(--color-primary)] hover:underline"
                        >
                          {h.name}
                          {h.distributor_count != null
                            ? ` (${h.distributor_count} distributor${h.distributor_count === 1 ? "" : "s"})`
                            : ""}
                        </Link>
                      ) : (
                        <Link
                          href={`/hcos/${encodeURIComponent(h.hco_key!)}`}
                          className="text-[var(--color-primary)] hover:underline"
                        >
                          {h.name}
                        </Link>
                      )}
                    </td>
                    <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                      {isUnmapped ? "—" : (h.hco_type ?? "—")}
                    </td>
                    <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                      {isUnmapped
                        ? "—"
                        : [h.city, h.state].filter(Boolean).join(", ") || "—"}
                    </td>
                    <td className="px-5 py-2 text-right font-mono">
                      {formatNumber(Math.round(h.net_units))}
                    </td>
                    <td className="px-5 py-2 text-right font-mono text-[var(--color-ink-muted)]">
                      {formatCompactDollars(h.net_gross_dollars)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {topRepsBySales.length > 0 ? (
        <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
          <div className="px-5 py-4 border-b border-[var(--color-border)]">
            <h2 className="font-display text-lg">Top reps by Units</h2>
            <p className="text-xs text-[var(--color-ink-muted)]">
              Net units in {period}, attributed via primary territory
              ownership. Unattributed sales (no rep assignment yet) appear
              as their own line so totals reconcile.
            </p>
          </div>
          <table className="w-full text-sm">
            <thead className="text-xs text-[var(--color-ink-muted)]">
              <tr>
                <th className="text-left font-normal px-5 py-2 w-8">#</th>
                <th className="text-left font-normal px-5 py-2">Rep</th>
                <th className="text-left font-normal px-5 py-2">Title</th>
                <th className="text-right font-normal px-5 py-2">HCOs</th>
                <th className="text-right font-normal px-5 py-2">Units</th>
                <th className="text-right font-normal px-5 py-2">Net dollars</th>
              </tr>
            </thead>
            <tbody>
              {topRepsBySales.map((r, i) => {
                const isUnattributed = r.rep_user_key == null;
                return (
                  <tr
                    key={r.rep_user_key ?? "__unattributed__"}
                    className={
                      "border-t border-[var(--color-border)] hover:bg-[var(--color-surface-alt)] " +
                      (isUnattributed ? "bg-[var(--color-surface-alt)]/40" : "")
                    }
                  >
                    <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                      {i + 1}
                    </td>
                    <td className="px-5 py-2">
                      {isUnattributed ? (
                        <Link
                          href="/admin/mappings"
                          className="text-[var(--color-ink-muted)] italic hover:text-[var(--color-primary)] hover:underline"
                          title="Sales without a rep — could be unmapped distributors, accounts not in any territory, or territories with no current rep. Click to manage mappings."
                        >
                          {r.rep_name}
                        </Link>
                      ) : (
                        <Link
                          href={`/reps/${encodeURIComponent(r.rep_user_key!)}`}
                          className="text-[var(--color-primary)] hover:underline"
                        >
                          {r.rep_name}
                        </Link>
                      )}
                    </td>
                    <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                      {isUnattributed ? "—" : (r.rep_title ?? "—")}
                    </td>
                    <td className="px-5 py-2 text-right text-[var(--color-ink-muted)]">
                      {r.account_count != null
                        ? formatNumber(r.account_count)
                        : "—"}
                    </td>
                    <td className="px-5 py-2 text-right font-mono">
                      {formatNumber(Math.round(r.net_units))}
                    </td>
                    <td className="px-5 py-2 text-right font-mono text-[var(--color-ink-muted)]">
                      {formatCompactDollars(r.net_gross_dollars)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      {topUnmapped.length > 0 ? (
        <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
          <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-baseline justify-between gap-4 flex-wrap">
            <div>
              <h2 className="font-display text-lg">
                Top distributors (unmapped)
              </h2>
              <p className="text-xs text-[var(--color-ink-muted)]">
                Highest-$ distributor accounts in {period} with no Veeva
                mapping yet. Mapping these makes their sales roll up into
                HCP / HCO views.
              </p>
            </div>
            <Link
              href="/admin/mappings"
              className="text-sm text-[var(--color-primary)] hover:underline whitespace-nowrap"
            >
              Map distributors →
            </Link>
          </div>
          <table className="w-full text-sm">
            <thead className="text-xs text-[var(--color-ink-muted)]">
              <tr>
                <th className="text-left font-normal px-5 py-2 w-8">#</th>
                <th className="text-left font-normal px-5 py-2">
                  Distributor ID
                </th>
                <th className="text-left font-normal px-5 py-2">Name</th>
                <th className="text-left font-normal px-5 py-2">State</th>
                <th className="text-right font-normal px-5 py-2">Units</th>
                <th className="text-right font-normal px-5 py-2">Net dollars</th>
                <th className="text-right font-normal px-5 py-2">Rows</th>
                <th className="text-right font-normal px-5 py-2">Last seen</th>
              </tr>
            </thead>
            <tbody>
              {topUnmapped.map((d, i) => (
                <tr
                  key={d.distributor_account_id}
                  className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-alt)]"
                >
                  <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                    {i + 1}
                  </td>
                  <td className="px-5 py-2 font-mono text-xs">
                    {d.distributor_account_id}
                  </td>
                  <td className="px-5 py-2">
                    {d.distributor_account_name ?? "—"}
                  </td>
                  <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                    {d.account_state ?? "—"}
                  </td>
                  <td className="px-5 py-2 text-right font-mono">
                    {formatNumber(Math.round(d.net_units))}
                  </td>
                  <td className="px-5 py-2 text-right font-mono text-[var(--color-ink-muted)]">
                    {formatCompactDollars(d.net_gross_dollars)}
                  </td>
                  <td className="px-5 py-2 text-right text-[var(--color-ink-muted)]">
                    {formatNumber(d.rows)}
                  </td>
                  <td className="px-5 py-2 text-right text-[var(--color-ink-muted)]">
                    {d.last_seen ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="text-center text-xs text-[var(--color-ink-muted)] pt-4">
        Need deeper analysis?{" "}
        <Link
          href="/reports"
          className="text-[var(--color-primary)] hover:underline"
        >
          Open the full Power BI report →
        </Link>
      </div>
    </div>
  );
}
