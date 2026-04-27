import { notFound } from "next/navigation";
import Link from "next/link";
import { queryFabric } from "@/lib/fabric";
import {
  loadInteractionKpis,
  loadTrend,
  hcoScope,
  type Scope,
} from "@/lib/interactions";
import {
  loadHcoSalesKpis,
  loadHcoSalesTrend,
  loadHcoTopProducts,
} from "@/lib/sales";
import { getCurrentScope, scopeToSql, combineScopes } from "@/lib/scope";
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

type HcoHeader = {
  hco_key: string;
  name: string;
  hco_type: string | null;
  hospital_type: string | null;
  account_group: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  bed_count: string | null;
  tier: string | null;
  segmentation: string | null;
  status: string | null;
};

async function loadHco(
  tenantId: string,
  hcoKey: string,
): Promise<HcoHeader | null> {
  const rows = await queryFabric<HcoHeader>(
    tenantId,
    `SELECT TOP 1
       hco_key, name, hco_type, hospital_type, account_group,
       city, state, postal_code, bed_count, tier, segmentation, status
     FROM gold.dim_hco
     WHERE tenant_id = @tenantId AND hco_key = @hcoKey`,
    { hcoKey },
  );
  return rows[0] ?? null;
}

// Reps who've called this HCO (mirrors HCP page's calling-reps panel).
type CallingRep = {
  user_key: string;
  name: string;
  title: string | null;
  calls: number;
  last_call: string | null;
};

async function loadHcoCallingReps(
  tenantId: string,
  filters: DashboardFilters,
  scope: Scope,
): Promise<CallingRep[]> {
  const { dateFilter, channelFilter } = filterClauses(filters);
  return queryFabric<CallingRep>(
    tenantId,
    `SELECT TOP 10 u.user_key, u.name, u.title,
       COUNT(*) AS calls,
       CONVERT(varchar(10), MAX(f.call_date), 23) AS last_call
     FROM gold.fact_call f
     JOIN gold.dim_user u ON u.user_key = f.owner_user_key AND u.tenant_id = @tenantId
     WHERE f.tenant_id = @tenantId
       ${dateFilter} ${channelFilter} ${scope.clauses.join(" ")}
     GROUP BY u.user_key, u.name, u.title
     ORDER BY calls DESC`,
    { ...filtersToParams(filters), ...scope.params },
  );
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatCompactDollars(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${Math.round(abs)}`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function daysSince(dateStr: string | null): string {
  if (!dateStr) return "Never";
  const date = new Date(dateStr);
  const diff = Math.floor((Date.now() - date.getTime()) / (1000 * 60 * 60 * 24));
  if (diff < 0) return formatDate(dateStr);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return `${diff} days ago`;
}

function deltaLabel(current: number, prior: number): string | null {
  if (prior === 0) return null;
  const pct = ((current - prior) / prior) * 100;
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(0)}% vs prior period`;
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type RouteParams = Promise<{ hco_key: string }>;

export default async function HcoDetail({
  params,
  searchParams,
}: {
  params: RouteParams;
  searchParams: SearchParams;
}) {
  const { hco_key } = await params;
  const filters = parseFilters(await searchParams);

  const { resolution } = await getCurrentScope();
  if (!resolution || !resolution.ok) notFound();
  const { scope: userScope } = resolution;
  const tenantId = userScope.tenantId;

  const hco = await loadHco(tenantId, hco_key);
  if (!hco) notFound();

  const sqlScope = combineScopes(hcoScope(hco_key), scopeToSql(userScope));
  // Sales loaders take the user-scope only (NOT combined with hcoScope —
  // sales loaders bring their own account_key filter from their hcoKey
  // param). Reps see only their attributed sales for this HCO; admins
  // see tenant-wide sales for it.
  const userSqlScope = scopeToSql(userScope);
  const [kpis, trend, callingReps, salesKpis, salesTrend, topProducts] =
    await Promise.all([
      loadInteractionKpis(tenantId, filters, sqlScope),
      loadTrend(tenantId, filters, sqlScope),
      loadHcoCallingReps(tenantId, filters, sqlScope),
      loadHcoSalesKpis(tenantId, hco_key, filters, userSqlScope),
      loadHcoSalesTrend(tenantId, hco_key, filters, userSqlScope),
      loadHcoTopProducts(tenantId, hco_key, filters, 10, userSqlScope),
    ]);

  // Show the sales-related surfaces only when this HCO actually has sales
  // history. New tenants (or HCOs that have never been a ship-to) get the
  // pure-calls layout the page used to render — no empty-table noise.
  const hasSalesHistory =
    salesKpis.last_sale != null ||
    salesKpis.net_gross_dollars_period !== 0 ||
    salesKpis.net_gross_dollars_prior !== 0;

  const period = periodLabel(filters.range);
  const cards: { label: string; value: string; delta: string | null }[] = [
    {
      label: `Interactions (${period})`,
      value: formatNumber(kpis.calls_period),
      delta:
        filters.range === "all"
          ? null
          : deltaLabel(kpis.calls_period, kpis.calls_prior),
    },
    {
      label: `Reps engaged (${period})`,
      value: formatNumber(kpis.reps),
      delta: null,
    },
    {
      label: "Last contact",
      value: daysSince(kpis.last_call),
      delta: kpis.last_call ? formatDate(kpis.last_call) : null,
    },
  ];
  if (hasSalesHistory) {
    cards.push({
      label: `Net sales (${period})`,
      value: formatCompactDollars(salesKpis.net_gross_dollars_period),
      delta:
        filters.range !== "all" && salesKpis.net_gross_dollars_prior !== 0
          ? deltaLabel(
              salesKpis.net_gross_dollars_period,
              salesKpis.net_gross_dollars_prior,
            )
          : null,
    });
  }

  const subtitleBits = [
    hco.hco_type,
    hco.account_group,
    [hco.city, hco.state].filter(Boolean).join(", ") || null,
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
            <h1 className="font-display text-3xl">{hco.name}</h1>
            <p className="text-[var(--color-ink-muted)] text-sm">
              {subtitleBits.join(" • ") || "—"}
              {hco.bed_count ? ` • ${hco.bed_count} beds` : ""}
            </p>
            {hco.tier || hco.segmentation || hco.hospital_type ? (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {hco.tier ? (
                  <span className="text-xs rounded px-2 py-0.5 bg-[var(--color-accent)]/15 text-[var(--color-ink)]">
                    Tier {hco.tier}
                  </span>
                ) : null}
                {hco.segmentation ? (
                  <span className="text-xs rounded px-2 py-0.5 bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)] border border-[var(--color-border)]">
                    {hco.segmentation}
                  </span>
                ) : null}
                {hco.hospital_type ? (
                  <span className="text-xs rounded px-2 py-0.5 bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)] border border-[var(--color-border)]">
                    {hco.hospital_type}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          <FilterBar filters={filters} />
        </div>
      </div>

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

      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
        <div className="px-5 py-4 border-b border-[var(--color-border)]">
          <h2 className="font-display text-lg">
            Calls — {GRANULARITY_LABELS[filters.granularity].toLowerCase()}
          </h2>
          <p className="text-xs text-[var(--color-ink-muted)]">
            {chartBuckets(filters)} most recent {filters.granularity}
            {chartBuckets(filters) === 1 ? "" : "s"} for {hco.name}
          </p>
        </div>
        <div className="px-2 py-4">
          <TrendChart data={trend} />
        </div>
      </div>

      {hasSalesHistory ? (
        <>
          <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
            <div className="px-5 py-4 border-b border-[var(--color-border)]">
              <h2 className="font-display text-lg">
                Net sales — {GRANULARITY_LABELS[filters.granularity].toLowerCase()}
              </h2>
              <p className="text-xs text-[var(--color-ink-muted)]">
                Signed gross dollars (sales − returns), {chartBuckets(filters)}{" "}
                most recent {filters.granularity}
                {chartBuckets(filters) === 1 ? "" : "s"} for {hco.name}
                {salesKpis.last_sale ? (
                  <>
                    {" "}· last sale {formatDate(salesKpis.last_sale)}
                  </>
                ) : null}
              </p>
            </div>
            <div className="px-2 py-4">
              <TrendChart
                data={salesTrend}
                valueKey="net_dollars"
                valueLabel="Net sales"
                format="dollars"
              />
            </div>
          </div>

          {topProducts.length > 0 ? (
            <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
              <div className="px-5 py-4 border-b border-[var(--color-border)]">
                <h2 className="font-display text-lg">Top products</h2>
                <p className="text-xs text-[var(--color-ink-muted)]">
                  By net sales in {period} for {hco.name}
                </p>
              </div>
              <table className="w-full text-sm">
                <thead className="text-xs text-[var(--color-ink-muted)]">
                  <tr>
                    <th className="text-left font-normal px-5 py-2 w-8">#</th>
                    <th className="text-left font-normal px-5 py-2">Product</th>
                    <th className="text-left font-normal px-5 py-2">NDC</th>
                    <th className="text-left font-normal px-5 py-2">Brand</th>
                    <th className="text-right font-normal px-5 py-2">Net sales</th>
                    <th className="text-right font-normal px-5 py-2">Units</th>
                  </tr>
                </thead>
                <tbody>
                  {topProducts.map((p, i) => (
                    <tr
                      key={p.product_ndc ?? `${p.product_name ?? "unknown"}-${i}`}
                      className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-alt)]"
                    >
                      <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                        {i + 1}
                      </td>
                      <td className="px-5 py-2">{p.product_name ?? "—"}</td>
                      <td className="px-5 py-2 font-mono text-xs text-[var(--color-ink-muted)]">
                        {p.product_ndc ?? "—"}
                      </td>
                      <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                        {p.brand ?? "—"}
                      </td>
                      <td className="px-5 py-2 text-right font-mono">
                        {formatCompactDollars(p.net_gross_dollars)}
                      </td>
                      <td className="px-5 py-2 text-right font-mono text-[var(--color-ink-muted)]">
                        {formatNumber(Math.round(p.net_units))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}

      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
        <div className="px-5 py-4 border-b border-[var(--color-border)]">
          <h2 className="font-display text-lg">Reps who&apos;ve called</h2>
          <p className="text-xs text-[var(--color-ink-muted)]">
            By calls in {period}
          </p>
        </div>
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
                  className="px-5 py-6 text-center text-[var(--color-ink-muted)]"
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
      </div>
    </div>
  );
}
