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
import { loadTopScoringAffiliatedHcps } from "@/lib/hcp-target-scores";
import { getCurrentScope, scopeToSql, combineScopes } from "@/lib/scope";
import { db } from "@/lib/db";
import { eq, schema } from "@throughline/db";
import AffiliatedHcpScoresCard from "@/components/affiliated-hcp-scores-card";
import HcoSnapshotCard from "@/components/hco-snapshot-card";
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

// Caveat text shown to non-admin viewers via a "?" tooltip on the
// Sales attribution card. Admins still see this as a permanent footer
// underneath the table; for reps/managers it's discover-on-demand
// per design review item #21 — they shouldn't have admin-context
// caveats permanently consuming card real-estate.
const ATTRIBUTION_CAVEAT =
  "How primary is picked: when an account is assigned to multiple territories, Throughline picks one as primary using this priority — territories with an assigned Sales rep first, then team role (SAM > KAD > ALL), then manual-over-rule, then alphabetical by name. To change: edit the account-territory assignment in Veeva (or assign a Sales-typed user to the territory if no rep is shown). Changes flow into Throughline on the next pipeline refresh.";

type HcoHeader = {
  hco_key: string;
  veeva_account_id: string;
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
       hco_key, veeva_account_id, name, hco_type, hospital_type,
       account_group, city, state, postal_code, bed_count, tier,
       segmentation, status
     FROM gold.dim_hco
     WHERE tenant_id = @tenantId AND hco_key = @hcoKey`,
    { hcoKey },
  );
  return rows[0] ?? null;
}

// Last-call-ever rolled up via HCP affiliation (all-time, filter-
// independent). Used by HcoSnapshotCard for engagement status —
// reflects actual HCO state regardless of page filter range. fact_call
// has no direct hco_key today, so we roll up via dim_hcp.primary_parent_hco_key
// (per project_gold_fact_call_followups).
async function loadLastCallEverForHco(
  tenantId: string,
  hcoKey: string,
): Promise<string | null> {
  try {
    const rows = await queryFabric<{ last_call: string | null }>(
      tenantId,
      `SELECT CONVERT(varchar(10), MAX(f.call_date), 23) AS last_call
       FROM gold.fact_call f
       JOIN gold.dim_hcp h
         ON h.hcp_key = f.hcp_key
         AND h.tenant_id = f.tenant_id
       WHERE f.tenant_id = @tenantId
         AND h.primary_parent_hco_key = @hcoKey`,
      { hcoKey },
    );
    return rows[0]?.last_call ?? null;
  } catch (err) {
    console.error("loadLastCallEverForHco failed:", err);
    return null;
  }
}

// Attribution chain for an HCO: which territories it's bridged to (with
// is_primary flag for sales-attribution purposes), each territory's
// current Sales rep, and the team_role / source. Surfaces the same
// data Phase A's gold_fact_sale_build uses to derive rep_user_key, so
// admins can see exactly WHY their sales for this HCO go where they go.
type HcoAttributionRow = {
  // 1 if primary, 0 otherwise. Cast to int in SQL because the
  // mssql/tedious driver can choke on Delta BOOLEAN over the SQL
  // analytics endpoint depending on table version.
  is_primary: number;
  territory_key: string;
  territory_name: string | null;
  // Geographic / human label (e.g. "Los Angeles"). When present, render as
  // primary label with `territory_name` (the Veeva code) as subtitle so
  // admins recognize the territory by region instead of code.
  territory_description: string | null;
  team_role: string | null;
  current_rep_user_key: string | null;
  current_rep_name: string | null;
  current_rep_source: string | null;
  is_manual: string | null;
  assignment_rule: string | null;
  assignment_name: string | null;
};

async function loadHcoAttributionChain(
  tenantId: string,
  hcoKey: string,
): Promise<HcoAttributionRow[]> {
  try {
    return await queryFabric<HcoAttributionRow>(
      tenantId,
      // `rule` is a T-SQL reserved keyword. The SQL analytics endpoint
       // rejects it even though Delta/Spark accepts it. Bracket-quote on
       // both the SELECT and the alias.
       `SELECT
         CAST(b.is_primary AS INT) AS is_primary,
         b.territory_key,
         t.name                  AS territory_name,
         t.description           AS territory_description,
         t.team_role,
         t.current_rep_user_key,
         t.current_rep_name,
         t.current_rep_source,
         b.is_manual,
         b.[rule]                AS assignment_rule,
         b.assignment_name
       FROM gold.bridge_account_territory b
       LEFT JOIN gold.dim_territory t
         ON t.tenant_id = b.tenant_id
         AND t.territory_key = b.territory_key
       WHERE b.tenant_id = @tenantId
         AND b.account_key = @hcoKey
       ORDER BY CAST(b.is_primary AS INT) DESC, t.name`,
      { hcoKey },
    );
  } catch (err) {
    console.error("loadHcoAttributionChain failed:", err);
    return [];
  }
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
  const isAdmin = userScope.role === "admin" || userScope.role === "bypass";

  const hco = await loadHco(tenantId, hco_key);
  if (!hco) notFound();

  const sqlScope = combineScopes(hcoScope(hco_key), scopeToSql(userScope));
  // Sales loaders take the user-scope only (NOT combined with hcoScope —
  // sales loaders bring their own account_key filter from their hcoKey
  // param). Reps see only their attributed sales for this HCO; admins
  // see tenant-wide sales for it.
  const userSqlScope = scopeToSql(userScope);
  const [
    kpis,
    trend,
    callingReps,
    salesKpis,
    salesTrend,
    topProducts,
    attributionChain,
    affiliatedScores,
    tenantVeevaRows,
    lastCallEver,
  ] = await Promise.all([
    loadInteractionKpis(tenantId, filters, sqlScope),
    loadTrend(tenantId, filters, sqlScope),
    loadHcoCallingReps(tenantId, filters, sqlScope),
    loadHcoSalesKpis(tenantId, hco_key, filters, userSqlScope),
    loadHcoSalesTrend(tenantId, hco_key, filters, userSqlScope),
    loadHcoTopProducts(tenantId, hco_key, filters, 10, userSqlScope),
    loadHcoAttributionChain(tenantId, hco_key),
    // Top affiliated HCPs at this HCO ranked by composite targeting
    // score. Surfaces "high-value physicians practicing here."
    loadTopScoringAffiliatedHcps({ tenantId, hcoKey: hco_key, limit: 10 }),
    // Vault domain for the Veeva deep link (existing veeva_account_id
    // is already on `hco`).
    db
      .select({ vaultDomain: schema.tenantVeeva.vaultDomain })
      .from(schema.tenantVeeva)
      .where(eq(schema.tenantVeeva.tenantId, tenantId))
      .limit(1),
    // All-time last call (filter-independent) for the HCO snapshot
    // engagement status.
    loadLastCallEverForHco(tenantId, hco_key),
  ]);
  const vaultDomain = tenantVeevaRows[0]?.vaultDomain ?? null;

  // Pull primary rep + primary territory for the snapshot from the
  // attribution chain (sorted is_primary DESC by the loader, so [0]).
  const primaryAttribution =
    attributionChain.find((a) => a.is_primary === 1) ?? null;
  // Top affiliated HCP for snapshot — first row from
  // loadTopScoringAffiliatedHcps (already sorted by score DESC).
  const topAffiliatedHcp = affiliatedScores[0] ?? null;

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
    const hcoSalesUnitsDelta =
      filters.range !== "all" && salesKpis.net_units_prior !== 0
        ? deltaLabel(
            salesKpis.net_units_period,
            salesKpis.net_units_prior,
          )
        : null;
    const hcoSalesDollarsLine =
      salesKpis.net_gross_dollars_period !== 0
        ? `${formatCompactDollars(salesKpis.net_gross_dollars_period)} net dollars`
        : null;
    cards.push({
      label: `Net units (${period})`,
      value: formatNumber(Math.round(salesKpis.net_units_period)),
      delta:
        hcoSalesDollarsLine && hcoSalesUnitsDelta
          ? `${hcoSalesDollarsLine} · ${hcoSalesUnitsDelta}`
          : hcoSalesDollarsLine ?? hcoSalesUnitsDelta,
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
            <h1 className="font-display text-[28px] leading-[1.2] tracking-tight">{hco.name}</h1>
            <p className="text-[var(--color-ink-muted)] text-sm">
              {subtitleBits.join(" • ") || "—"}
              {hco.bed_count ? ` • ${hco.bed_count} beds` : ""}
            </p>
            <p className="text-[var(--color-ink-muted)] text-xs mt-1">
              <span className="text-[var(--color-ink-muted)]">Veeva ID:</span>{" "}
              <span className="font-mono">{hco.veeva_account_id}</span>
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

      <HcoSnapshotCard
        inputs={{
          last_call_ever: lastCallEver,
          net_units_period: salesKpis.net_units_period,
          net_units_prior: salesKpis.net_units_prior,
          last_sale_date: salesKpis.last_sale,
          tier: hco.tier,
          hco_type: hco.hco_type,
          primary_rep_user_key: primaryAttribution?.current_rep_user_key ?? null,
          primary_rep_name: primaryAttribution?.current_rep_name ?? null,
          primary_territory_label:
            primaryAttribution?.territory_description ??
            primaryAttribution?.territory_name ??
            null,
          top_affiliated_hcp: topAffiliatedHcp
            ? {
                hcp_key: topAffiliatedHcp.hcp_key,
                name: topAffiliatedHcp.name,
                score: topAffiliatedHcp.score_value,
              }
            : null,
          veeva_account_id: hco.veeva_account_id,
          vault_domain: vaultDomain,
        }}
      />

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

      <AffiliatedHcpScoresCard
        hcos={affiliatedScores}
        hcoName={hco.name}
      />

      {hasSalesHistory ? (
        <>
          <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
            <div className="px-5 py-4 border-b border-[var(--color-border)]">
              <h2 className="font-display text-lg">
                Net units — {GRANULARITY_LABELS[filters.granularity].toLowerCase()}
              </h2>
              <p className="text-xs text-[var(--color-ink-muted)]">
                Signed units (sales − returns), {chartBuckets(filters)}{" "}
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
                valueKey="net_units"
                valueLabel="Net units"
                format="number"
              />
            </div>
          </div>

          {topProducts.length > 0 ? (
            <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
              <div className="px-5 py-4 border-b border-[var(--color-border)]">
                <h2 className="font-display text-lg">Top products</h2>
                <p className="text-xs text-[var(--color-ink-muted)]">
                  By units in {period} for {hco.name}
                </p>
              </div>
              <table className="w-full text-sm">
                <thead className="text-xs text-[var(--color-ink-muted)]">
                  <tr>
                    <th className="text-left font-normal px-5 py-2 w-8">#</th>
                    <th className="text-left font-normal px-5 py-2">Product</th>
                    <th className="text-left font-normal px-5 py-2">NDC</th>
                    <th className="text-left font-normal px-5 py-2">Brand</th>
                    <th className="text-right font-normal px-5 py-2">Units</th>
                    <th className="text-right font-normal px-5 py-2">Net dollars</th>
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
                        {formatNumber(Math.round(p.net_units))}
                      </td>
                      <td className="px-5 py-2 text-right font-mono text-[var(--color-ink-muted)]">
                        {formatCompactDollars(p.net_gross_dollars)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}

      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="font-display text-lg">Sales attribution</h2>
            <p className="text-xs text-[var(--color-ink-muted)]">
              Which territory + rep this account&apos;s sales roll up to.
              Set in Veeva via account-territory assignments. The{" "}
              <span className="font-medium">Primary</span> row is the one
              dashboard sales aggregates use.
            </p>
          </div>
          {/* Per design review #21: non-admins get the admin-context
              caveat (how primary is picked, how to change) behind a
              "?" tooltip affordance instead of permanent footer
              text. Admins still see the full footer below. */}
          {!isAdmin ? (
            <button
              type="button"
              aria-label={ATTRIBUTION_CAVEAT}
              title={ATTRIBUTION_CAVEAT}
              className="flex-shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full border border-[var(--color-border)] text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-alt)] text-xs leading-none"
            >
              ?
            </button>
          ) : null}
        </div>
        {attributionChain.length === 0 ? (
          <div className="px-5 py-6 text-sm text-[var(--color-ink-muted)]">
            No territory assignments found for this account in Veeva. Sales
            for this HCO will roll up under <span className="italic">Unattributed</span>{" "}
            on the dashboard until an admin assigns it to a territory in
            Veeva (and a Sales-typed rep is on that territory).
          </div>
        ) : (
        <>
        <table className="w-full text-sm">
            <thead className="text-xs text-[var(--color-ink-muted)]">
              <tr>
                <th className="text-left font-normal px-5 py-2 w-20">Primary</th>
                <th className="text-left font-normal px-5 py-2">Territory</th>
                <th className="text-left font-normal px-5 py-2">Team role</th>
                <th className="text-left font-normal px-5 py-2">Current Sales rep</th>
                <th className="text-left font-normal px-5 py-2">Assignment</th>
              </tr>
            </thead>
            <tbody>
              {attributionChain.map((a) => (
                <tr
                  key={a.territory_key}
                  className={
                    "border-t border-[var(--color-border)] " +
                    (a.is_primary === 1
                      ? "bg-[var(--color-positive)]/5"
                      : "")
                  }
                >
                  <td className="px-5 py-2">
                    {a.is_primary === 1 ? (
                      <span className="text-xs rounded px-2 py-0.5 bg-[var(--color-positive)]/15 text-[var(--color-positive-deep)]">
                        Primary
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--color-ink-muted)]">
                        Secondary
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-2">
                    {a.territory_description ? (
                      <>
                        <div>{a.territory_description}</div>
                        {a.territory_name ? (
                          <div className="text-xs text-[var(--color-ink-muted)] font-mono">
                            {a.territory_name}
                          </div>
                        ) : null}
                      </>
                    ) : (
                      a.territory_name ?? a.territory_key.slice(0, 8) + "…"
                    )}
                  </td>
                  <td className="px-5 py-2 text-[var(--color-ink-muted)] text-xs">
                    {a.team_role ?? "—"}
                  </td>
                  <td className="px-5 py-2">
                    {a.current_rep_user_key ? (
                      <Link
                        href={`/reps/${encodeURIComponent(a.current_rep_user_key)}`}
                        className="text-[var(--color-primary)] hover:underline"
                      >
                        {a.current_rep_name ?? "—"}
                      </Link>
                    ) : (
                      <span className="text-[var(--color-ink-muted)] italic">
                        No Sales rep assigned to this territory
                      </span>
                    )}
                  </td>
                  <td className="px-5 py-2 text-[var(--color-ink-muted)] text-xs">
                    {/* Veeva sends manual__v as a string; sometimes "true",
                        sometimes "True", sometimes "1". Normalize. */}
                    {(() => {
                      const m = (a.is_manual ?? "").toLowerCase();
                      const isManual = m === "true" || m === "1" || m === "yes";
                      if (isManual) return "Manual";
                      if (a.assignment_rule) return `Rule: ${a.assignment_rule}`;
                      return "—";
                    })()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {isAdmin ? (
            <div className="px-5 py-3 text-xs text-[var(--color-ink-muted)] border-t border-[var(--color-border)] bg-[var(--color-surface-alt)]/40 space-y-1">
              <p>
                <strong className="text-[var(--color-ink)]">How primary is picked:</strong>{" "}
                when an account is assigned to multiple territories (Veeva
                supports this), Throughline picks one as primary for sales
                attribution using this priority — territories with an
                assigned Sales rep first, then team role (SAM &gt; KAD &gt;
                ALL), then manual-over-rule assignments, then alphabetical
                by territory name.
              </p>
              <p>
                <strong className="text-[var(--color-ink)]">To change:</strong>{" "}
                edit the account-territory assignment in Veeva (or assign a
                Sales-typed user to the territory if no rep is shown). Changes
                flow into Throughline on the next pipeline refresh.
              </p>
            </div>
          ) : null}
        </>
        )}
      </div>

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
      </div>
    </div>
  );
}
