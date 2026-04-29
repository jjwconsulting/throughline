import Link from "next/link";
import {
  loadInteractionKpis,
  loadTrend,
  loadTopReps,
  loadTopHcps,
  loadTopHcos,
  loadTierCoverage,
} from "@/lib/interactions";
import { loadTeamRollup } from "@/lib/team";
import {
  loadSalesKpis,
  loadSalesTrend,
  loadTopUnmappedDistributors,
  loadTopHcosBySales,
  loadTopRepsBySales,
  loadRepCurrentTerritoryKeys,
  loadAccountMotion,
  loadWatchListAccounts,
  loadNewAccounts,
  loadAccessibleTerritories,
} from "@/lib/sales";
import { getCurrentScope, scopeToSql } from "@/lib/scope";
import { loadHcpInactivitySignals } from "@/lib/signals";
import {
  loadOverlappingGoalSum,
  attainmentLabel,
} from "@/lib/goal-lookup";
import SignalsPanel from "@/components/signals-panel";
import SynopsisCard from "@/components/synopsis-card";
import AccountMotionPanel from "@/components/account-motion-panel";
import Sparkline from "@/components/sparkline";
import InlineBar from "@/components/inline-bar";
import { loadDashboardSynopsis } from "@/lib/synopsis";
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

// Color band for attainment % cells in the team rollup. Mirrors the
// thresholds used on the tier coverage panel so the dashboard reads
// consistently. Null = no goal / no measurement → muted.
function attainColor(pct: number | null): string {
  if (pct == null) return "text-[var(--color-ink-muted)]";
  if (pct >= 90) return "text-[var(--color-positive-deep)]";
  if (pct >= 70) return "text-[var(--color-ink-muted)]";
  return "text-[var(--color-negative-deep)]";
}

function daysAgo(isoDate: string): number {
  const d = new Date(isoDate);
  return Math.max(
    0,
    Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24)),
  );
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function Dashboard({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const sp = await searchParams;
  const filters = parseFilters(sp);
  // Account motion tab — URL-driven so views are bookmarkable.
  const motionTabRaw = Array.isArray(sp.motion) ? sp.motion[0] : sp.motion;
  const motionTab: "rising" | "declining" | "watch" | "new" =
    motionTabRaw === "declining" ||
    motionTabRaw === "watch" ||
    motionTabRaw === "new"
      ? motionTabRaw
      : "rising";
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
  // Calls goal lookup. Suppressed entirely when a territory filter is
  // active — call goals live at the REP entity, and a multi-territory
  // rep's full goal can't be honestly pro-rated to one of their N
  // territories. Showing a tenant-wide goal denominator next to a
  // territory-narrowed actual would skew attainment to look artificially
  // low. Falls back to vs-prior delta instead, which DOES narrow
  // correctly because both period and prior actuals share the filter.
  const goalLookup =
    dateRange && !filters.territory
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
  // Units goal lookup: territory-entity. Cleanly slices by territory
  // since the goal entity IS territory — when filter is set we just
  // narrow to that one territory's goal. Otherwise: rep-role uses
  // their effective goal (sum across current territories); admin /
  // manager / bypass use tenant-wide sum.
  const unitsGoalLookup = dateRange
    ? filters.territory
      ? loadOverlappingGoalSum({
          tenantId,
          metric: "units",
          entityType: "territory",
          entityFilter: { type: "single", id: filters.territory },
          rangeStart: dateRange.start,
          rangeEnd: dateRange.end,
        })
      : scope.role === "rep"
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

  // Load accessible territories first — both the FilterBar (renders the
  // dropdown) and loadTierCoverage (needs the key list to scope the HCP
  // universe) depend on it. One extra round-trip; the query is cheap.
  const accessibleTerritories = await loadAccessibleTerritories(
    tenantId,
    scope,
  );
  const accessibleTerritoryKeys = accessibleTerritories.map(
    (t) => t.territory_key,
  );

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
    risingAccounts,
    decliningAccounts,
    watchList,
    newAccounts,
    tierCoverage,
    teamRollup,
    synopsis,
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
    loadAccountMotion(tenantId, filters, "rising", 10, rlsScope),
    loadAccountMotion(tenantId, filters, "declining", 10, rlsScope),
    loadWatchListAccounts(tenantId, filters, 10, rlsScope),
    loadNewAccounts(tenantId, filters, 10, rlsScope),
    loadTierCoverage(tenantId, filters, accessibleTerritoryKeys, rlsScope),
    loadTeamRollup(tenantId, scope, filters),
    // Synopsis is naturally low-frequency: cached per (user × pipeline_run)
    // so repeated dashboard loads against the same data refresh hit
    // cache + skip the LLM call. Returns hide={no_run|dismissed|no_changes|...}
    // when the card shouldn't render.
    loadDashboardSynopsis({ userScope: scope, userEmail, sqlScope: rlsScope }),
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
  const interactionsPrimary =
    periodGoal != null && periodGoal > 0
      ? attainmentLabel(kpis.calls_period, periodGoal).label
      : filters.range === "all"
        ? null
        : deltaLabel(kpis.calls_period, kpis.calls_prior);
  // Live-vs-dropoff split — surfaces what fraction of "calls" are real
  // engagement vs logistical drop-offs. Only renders when (a) the
  // tenant captures drop_off_visit (any non-zero dropoff count), AND
  // (b) the user hasn't already filtered to one side. Treats it as a
  // secondary-line fact alongside attainment / delta.
  const hasDropoffData =
    kpis.dropoff_calls_period > 0 &&
    filters.callKind === "all";
  const liveDropoffLine = hasDropoffData
    ? `${formatNumber(kpis.live_calls_period)} live · ${formatNumber(kpis.dropoff_calls_period)} drop-off`
    : null;
  const interactionsSecondary =
    interactionsPrimary && liveDropoffLine
      ? `${interactionsPrimary} · ${liveDropoffLine}`
      : interactionsPrimary ?? liveDropoffLine;
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
  // KPI cards. `sparkline` is optional: only the metrics with an
  // already-loaded trend series get one — Interactions reuses the
  // `trend` data already on the page (calls per bucket); Net units
  // reuses `salesTrend`. HCPs reached + Active reps don't have a
  // per-bucket loader yet, so they ship without a sparkline rather
  // than firing extra queries. Per design review viz addendum §1.
  const cards: {
    label: string;
    value: string;
    delta: string | null;
    sparkline?: { value: number }[];
  }[] = [
    {
      label: `${interactionLabel} (${period})`,
      value: formatNumber(kpis.calls_period),
      delta: interactionsSecondary,
      sparkline: trend.map((t) => ({ value: t.calls })),
    },
    { label: `${reachLabel} (${period})`, value: reachValue, delta: null },
    { label: `Active reps (${period})`, value: formatNumber(kpis.reps), delta: null },
    {
      label: `Net units (${period})`,
      value: formatNumber(Math.round(salesKpis.net_units_period)),
      delta: salesSecondary,
      sparkline: salesTrend.map((t) => ({ value: t.net_units })),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-[28px] leading-[1.2] tracking-tight">Dashboard</h1>
          <p className="text-[var(--color-ink-muted)]">
            Live from gold tables. Filters apply to all panels below.{" "}
            <Link
              href="/reports"
              className="text-[var(--color-primary)] hover:underline"
            >
              Open Power BI →
            </Link>
          </p>
        </div>
        <FilterBar filters={filters} territories={accessibleTerritories} />
      </div>

      {/* TODAY — synopsis only, conditional. Hides entirely on no
          synopsis (this period takes the top slot). Per design
          review §1A. */}
      {synopsis.kind === "show" ? (
        <section className="space-y-4 pt-2">
          <h2 className="h2-section">Today</h2>
          <SynopsisCard
            body={synopsis.body}
            generatedAt={synopsis.generatedAt}
          />
        </section>
      ) : null}

      {/* THIS PERIOD — orientation row: account toggle + 4 KPI cards. */}
      <section className="space-y-4 pt-6 border-t border-[var(--color-border)]">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <h2 className="h2-section">This period</h2>
          <AccountToggle value={filters.account} />
        </div>
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
              {c.sparkline && c.sparkline.length > 1 ? (
                <div className="mt-3">
                  <Sparkline data={c.sparkline} ariaLabel={`${c.label} trend`} />
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      {/* TRENDS — Calls + Net units side-by-side at lg+ so the user
          can correlate calls vs sales passively. Stacks at md and
          below per design review §1A.b. */}
      <section className="space-y-4 pt-6 border-t border-[var(--color-border)]">
        <h2 className="h2-section">Trends</h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
            <div className="px-5 py-4 border-b border-[var(--color-border)]">
              <h3 className="font-display text-lg">
                Calls — {GRANULARITY_LABELS[filters.granularity].toLowerCase()}
              </h3>
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
                <h3 className="font-display text-lg">
                  Net units — {GRANULARITY_LABELS[filters.granularity].toLowerCase()}
                </h3>
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
        </div>
      </section>

      {/* THINGS TO ACT ON — SignalsPanel + AccountMotionPanel
          side-by-side at lg+. Per design review §1A:
          AccountMotionPanel moves UP from previous bottom-of-page
          position to here; it's an action surface, not a footer. */}
      <section className="space-y-4 pt-6 border-t border-[var(--color-border)]">
        <h2 className="h2-section">Things to act on</h2>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <SignalsPanel
            title="HCPs to re-engage"
            subtitle={`Engaged previously, no contact in the last ${60} days`}
            signals={inactivitySignals}
            emptyHint="No lapsed HCPs in your scope. Either coverage is current or the data window is too narrow."
          />
          <AccountMotionPanel
            active={motionTab}
            period={period}
            rising={risingAccounts}
            declining={decliningAccounts}
            watch={watchList}
            newAccounts={newAccounts}
            searchParams={sp}
          />
        </div>
      </section>

      {/* ROLLUPS — all "Top X" tables and tier/team rollups. Per
          design review §1A: hierarchical roll-ups belong below the
          actionable middle of the page. */}
      <section className="space-y-4 pt-6 border-t border-[var(--color-border)]">
        <h2 className="h2-section">Rollups</h2>

      {tierCoverage.length > 0 ? (
        <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
          <div className="px-5 py-4 border-b border-[var(--color-border)]">
            <h3 className="font-display text-lg">HCP tier coverage</h3>
            <p className="text-xs text-[var(--color-ink-muted)]">
              Share of in-scope HCPs in each tier with at least one
              interaction in {period}. Universe is HCPs assigned to any
              {filters.territory ? " selected " : " visible "}territory in
              Veeva.
            </p>
          </div>
          {/* One row per tier — tier label, stacked horizontal bar
              showing contacted vs no-activity proportion, then count
              + percent on the right. Replaces the previous count
              table per design review viz addendum: the actual
              question ("am I weak on Tier 2?") is a proportion
              question, not a count question. The InlineBar's track
              (gray) is the no-activity portion; its fill (green) is
              the contacted portion — same primitive, semantic shift. */}
          <ul className="divide-y divide-[var(--color-border)]">
            {tierCoverage.map((row) => {
              const pct = Number(row.pct_contacted) || 0;
              const total = Number(row.total_hcps) || 0;
              const contacted = Number(row.contacted) || 0;
              const pctColor =
                pct >= 80
                  ? "text-[var(--color-positive-deep)]"
                  : pct >= 50
                    ? "text-[var(--color-ink-muted)]"
                    : "text-[var(--color-negative-deep)]";
              return (
                <li
                  key={row.tier}
                  className="flex items-center gap-4 px-5 py-3"
                >
                  <span className="w-20 text-sm flex-shrink-0">
                    {row.tier === "Unknown" ? (
                      <span className="text-[var(--color-ink-muted)] italic">
                        Unknown
                      </span>
                    ) : (
                      `Tier ${row.tier}`
                    )}
                  </span>
                  <span className="flex-1">
                    <InlineBar pct={pct} />
                  </span>
                  <span className="font-mono text-sm text-right whitespace-nowrap">
                    <span className={pctColor}>{pct}%</span>
                    <span className="text-[var(--color-ink-muted)] ml-2">
                      {formatNumber(contacted)} / {formatNumber(total)}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {teamRollup.length > 0 ? (
        <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
          <div className="px-5 py-4 border-b border-[var(--color-border)]">
            <h3 className="font-display text-lg">
              {scope.role === "manager" ? "Your team" : "All reps"}
            </h3>
            <p className="text-xs text-[var(--color-ink-muted)]">
              {teamRollup.length} rep{teamRollup.length === 1 ? "" : "s"} in
              {scope.role === "manager" ? " your team" : " the tenant"} —
              sorted by sales attainment (lowest first). Click a name for
              their detail page.
            </p>
          </div>
          <table className="w-full text-sm">
            <thead className="text-xs text-[var(--color-ink-muted)]">
              <tr>
                <th className="text-left font-normal px-5 py-2">Rep</th>
                <th className="text-right font-normal px-5 py-2">Calls</th>
                <th className="text-right font-normal px-5 py-2">
                  Calls attain
                </th>
                <th className="text-right font-normal px-5 py-2">Net units</th>
                <th className="text-right font-normal px-5 py-2">
                  Units attain
                </th>
                <th className="text-left font-normal px-5 py-2">Last call</th>
              </tr>
            </thead>
            <tbody>
              {teamRollup.map((r) => (
                <tr
                  key={r.user_key}
                  className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-alt)]"
                >
                  <td className="px-5 py-2">
                    <Link
                      href={`/reps/${encodeURIComponent(r.user_key)}`}
                      className="text-[var(--color-primary)] hover:underline"
                    >
                      {r.name}
                    </Link>
                    {r.title ? (
                      <div className="text-xs text-[var(--color-ink-muted)]">
                        {r.title}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-5 py-2 text-right font-mono">
                    {formatNumber(r.calls_period)}
                  </td>
                  <td
                    className={`px-5 py-2 text-right font-mono ${attainColor(r.calls_attainment_pct)}`}
                    title={
                      r.calls_goal != null
                        ? `${formatNumber(r.calls_period)} / ${formatNumber(Math.round(r.calls_goal))}`
                        : "No call goal set"
                    }
                  >
                    {r.calls_attainment_pct != null
                      ? `${Math.round(r.calls_attainment_pct)}%`
                      : "—"}
                  </td>
                  <td className="px-5 py-2 text-right font-mono">
                    {formatNumber(Math.round(r.net_units_period))}
                  </td>
                  <td
                    className={`px-5 py-2 text-right font-mono ${attainColor(r.units_attainment_pct)}`}
                    title={
                      r.units_goal != null
                        ? `${formatNumber(Math.round(r.net_units_period))} / ${formatNumber(Math.round(r.units_goal))}`
                        : "No effective units goal (no current territories with goals)"
                    }
                  >
                    {r.units_attainment_pct != null
                      ? `${Math.round(r.units_attainment_pct)}%`
                      : "—"}
                  </td>
                  <td
                    className={
                      "px-5 py-2 " +
                      (r.last_call_date && daysAgo(r.last_call_date) > 7
                        ? "text-[var(--color-ink-muted)]"
                        : "")
                    }
                  >
                    {r.last_call_date
                      ? `${daysAgo(r.last_call_date)}d ago`
                      : "Never"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
          <div className="px-5 py-4 border-b border-[var(--color-border)]">
            <h3 className="font-display text-lg">Top reps</h3>
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
              {topReps.length === 0 ? (
                <tr>
                  <td
                    colSpan={3}
                    className="px-5 py-8 text-center text-sm text-[var(--color-ink-muted)] italic"
                  >
                    No calls in this period.
                  </td>
                </tr>
              ) : (
                topReps.map((r, i) => (
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
                    <td className="px-5 py-2">
                      <div className="flex items-center justify-end gap-2 font-mono">
                        <span className="w-16">
                          <InlineBar pct={(r.calls / (topReps[0]?.calls || 1)) * 100} />
                        </span>
                        <span>{formatNumber(r.calls)}</span>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
          <div className="px-5 py-4 border-b border-[var(--color-border)]">
            <h3 className="font-display text-lg">
              {showHcos ? "Top HCOs" : "Top HCPs"}
            </h3>
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
                {topHcos.length === 0 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="px-5 py-8 text-center text-sm text-[var(--color-ink-muted)] italic"
                    >
                      No HCO calls in this period.
                    </td>
                  </tr>
                ) : (
                  topHcos.map((h, i) => (
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
                      <td className="px-5 py-2">
                        <div className="flex items-center justify-end gap-2 font-mono">
                          <span className="w-16">
                            <InlineBar pct={(h.calls / (topHcos[0]?.calls || 1)) * 100} />
                          </span>
                          <span>{formatNumber(h.calls)}</span>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
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
                {topHcps.length === 0 ? (
                  <tr>
                    <td
                      colSpan={4}
                      className="px-5 py-8 text-center text-sm text-[var(--color-ink-muted)] italic"
                    >
                      No HCP calls in this period.
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
                      <td className="px-5 py-2">
                        <div className="flex items-center justify-end gap-2 font-mono">
                          <span className="w-16">
                            <InlineBar pct={(h.calls / (topHcps[0]?.calls || 1)) * 100} />
                          </span>
                          <span>{formatNumber(h.calls)}</span>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {topHcosBySales.length > 0 ? (
        <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
          <div className="px-5 py-4 border-b border-[var(--color-border)]">
            <h3 className="font-display text-lg">Top HCOs by Units</h3>
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
                    <td className="px-5 py-2">
                      <div className="flex items-center justify-end gap-2 font-mono">
                        <span className="w-16">
                          <InlineBar
                            pct={
                              (h.net_units / (topHcosBySales[0]?.net_units || 1)) * 100
                            }
                          />
                        </span>
                        <span>{formatNumber(Math.round(h.net_units))}</span>
                      </div>
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
            <h3 className="font-display text-lg">Top reps by Units</h3>
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
                    <td className="px-5 py-2">
                      <div className="flex items-center justify-end gap-2 font-mono">
                        <span className="w-16">
                          <InlineBar
                            pct={
                              (r.net_units / (topRepsBySales[0]?.net_units || 1)) * 100
                            }
                          />
                        </span>
                        <span>{formatNumber(Math.round(r.net_units))}</span>
                      </div>
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
      </section>

      {/* DATA HEALTH — admin / data-quality concerns. Demoted to
          page bottom and visually muted (surface-alt background) per
          design review §1A. Section hides entirely when topUnmapped
          is empty (admins only — non-admins never see it). */}
      {topUnmapped.length > 0 ? (
      <section className="space-y-4 pt-6 border-t border-[var(--color-border)]">
        <h2 className="h2-section">Data health</h2>
        <div className="rounded-lg bg-[var(--color-surface-alt)] border border-[var(--color-border)] overflow-hidden">
          <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-baseline justify-between gap-4 flex-wrap">
            <div>
              <h3 className="font-display text-lg">
                Top distributors (unmapped)
              </h3>
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
      </section>
      ) : null}

    </div>
  );
}
