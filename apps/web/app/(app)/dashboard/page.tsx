import Link from "next/link";
import {
  loadInteractionKpis,
  loadWeeklyTrend,
  loadTopReps,
  loadTopHcps,
  loadTopHcos,
} from "@/lib/interactions";
import { getCurrentScope, scopeToSql } from "@/lib/scope";
import { loadHcpInactivitySignals } from "@/lib/signals";
import {
  sumRepGoalsForPeriod,
  findGoalContaining,
  prorateGoalByBusinessDays,
  attainmentLabel,
} from "@/lib/goal-lookup";
import SignalsPanel from "@/components/signals-panel";
import TrendChart from "./trend-chart";
import FilterBar from "./filter-bar";
import AccountToggle from "./account-toggle";
import NoAccess from "./no-access";
import { parseFilters, chartWeeks, periodLabel, rangeDates } from "./filters";

export const dynamic = "force-dynamic";

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
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
  // filter has a concrete date range (skip "all"). For per-rep scopes, the
  // goal is the rep's own goal; for admin/manager, sum of goals across
  // visible reps.
  const dateRange = rangeDates(filters.range);
  const goalLookup = (async () => {
    if (!dateRange) return null;
    if (scope.role === "rep") {
      const goal = await findGoalContaining({
        tenantId,
        metric: "calls",
        entityType: "rep",
        entityId: scope.userKey,
        rangeStart: dateRange.start,
        rangeEnd: dateRange.end,
      });
      return goal
        ? prorateGoalByBusinessDays({
            tenantId,
            goal,
            rangeStart: dateRange.start,
            rangeEnd: dateRange.end,
          })
        : null;
    }
    // admin / manager / bypass: sum of all (visible) rep goals. Tenant-wide
    // sum doesn't have a single canonical period to prorate against, so we
    // sum the unprorated targets for now. Refinement: prorate each goal
    // individually then sum, when the right semantic becomes obvious.
    return sumRepGoalsForPeriod({
      tenantId,
      metric: "calls",
      rangeStart: dateRange.start,
      rangeEnd: dateRange.end,
    });
  })();

  const [kpis, trend, topReps, topHcps, topHcos, inactivitySignals, periodGoal] =
    await Promise.all([
      loadInteractionKpis(tenantId, filters, rlsScope),
      loadWeeklyTrend(tenantId, filters, rlsScope),
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
  const cards: { label: string; value: string; delta: string | null }[] = [
    {
      label: `${interactionLabel} (${period})`,
      value: formatNumber(kpis.calls_period),
      delta: interactionsSecondary,
    },
    { label: `${reachLabel} (${period})`, value: reachValue, delta: null },
    { label: `Active reps (${period})`, value: formatNumber(kpis.reps), delta: null },
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
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
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
          <h2 className="font-display text-lg">Calls per week</h2>
          <p className="text-xs text-[var(--color-ink-muted)]">
            {chartWeeks(filters.range)} most recent weeks
          </p>
        </div>
        <div className="px-2 py-4">
          <TrendChart data={trend} goalTotal={periodGoal} />
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
