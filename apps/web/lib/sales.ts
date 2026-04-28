// Sales query helpers, mirror of interactions.ts but for gold.fact_sale.
//
// All loaders are wrapped in try/catch so the dashboard still renders if
// gold.fact_sale doesn't exist yet (cold start before the sales pipeline
// runs). Empty results = $0 cards + empty trend, never a 500.
//
// RLS: gold.fact_sale.rep_user_key is populated as of Phase A (sales
// attribution via dim_territory + bridge_account_territory). Reps see only
// their attributed sales; managers see their team's; admins see all.
// Unattributed rows (rep_user_key IS NULL) include unmapped distributors,
// accounts not in any territory, and territories with no current rep —
// per project_unmapped_sales_visibility memory, they MUST stay visible
// in tenant-wide aggregates and surface separately as "Unattributed".

import { queryFabric } from "@/lib/fabric";
import {
  rangeDates,
  rangeDays,
  chartBuckets,
  filtersToParams,
  territorySalesFilter,
  type DashboardFilters,
  type Granularity,
} from "@/app/(app)/dashboard/filters";
import { type Scope, NO_SCOPE } from "@/lib/interactions";
import type { UserScope } from "@/lib/scope";

// Sales-side RLS clauses use `f.rep_user_key` (different column than
// fact_call's `f.owner_user_key`). interactions.ts emits clauses keyed
// on owner_user_key; we rewrite them here so the same UserScope can drive
// both. Cheaper than building a parallel scope-emitter.
function rewriteScopeForSales(scope: Scope): Scope {
  return {
    clauses: scope.clauses.map((c) => c.replaceAll("owner_user_key", "rep_user_key")),
    params: scope.params,
  };
}

function scopeSql(scope: Scope): string {
  return scope.clauses.join(" ");
}

// ---------------------------------------------------------------------------
// KPIs
// ---------------------------------------------------------------------------

export type SalesKpis = {
  net_units_period: number;
  net_units_prior: number;
  net_gross_dollars_period: number;
  net_gross_dollars_prior: number;
  // Distinct accounts seen in the window. Mapped = resolved via account_xref;
  // unmapped = surface for /admin/mappings work.
  accounts_mapped: number;
  accounts_unmapped: number;
};

function emptySalesKpis(): SalesKpis {
  return {
    net_units_period: 0,
    net_units_prior: 0,
    net_gross_dollars_period: 0,
    net_gross_dollars_prior: 0,
    accounts_mapped: 0,
    accounts_unmapped: 0,
  };
}

function isoDateMinusDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function loadSalesKpis(
  tenantId: string,
  filters: DashboardFilters,
  scope: Scope = NO_SCOPE,
): Promise<SalesKpis> {
  try {
    const salesScope = rewriteScopeForSales(scope);
    const params = { ...filtersToParams(filters), ...salesScope.params };
    const dates = rangeDates(filters.range);

    if (!dates) {
      const rows = await queryFabric<SalesKpis>(
        tenantId,
        `SELECT
           COALESCE(SUM(signed_units), 0) AS net_units_period,
           0 AS net_units_prior,
           COALESCE(SUM(signed_gross_dollars), 0) AS net_gross_dollars_period,
           0 AS net_gross_dollars_prior,
           COUNT(DISTINCT CASE WHEN account_key IS NOT NULL THEN account_key END) AS accounts_mapped,
           COUNT(DISTINCT CASE WHEN account_key IS NULL THEN distributor_account_id END) AS accounts_unmapped
         FROM gold.fact_sale f
         WHERE f.tenant_id = @tenantId
           ${scopeSql(salesScope)}
           ${territorySalesFilter(filters)}`,
        params,
      );
      return rows[0] ?? emptySalesKpis();
    }

    const days = rangeDays(filters.range)!;
    const periodStart = dates.start;
    const periodEnd = dates.end;
    const priorStart = isoDateMinusDays(periodStart, days);
    const priorEnd = isoDateMinusDays(periodStart, 1);

    const rows = await queryFabric<SalesKpis>(
      tenantId,
      `SELECT
         COALESCE(SUM(CASE WHEN transaction_date >= @kpiPeriodStart AND transaction_date <= @kpiPeriodEnd THEN signed_units ELSE 0 END), 0) AS net_units_period,
         COALESCE(SUM(CASE WHEN transaction_date >= @kpiPriorStart  AND transaction_date <= @kpiPriorEnd  THEN signed_units ELSE 0 END), 0) AS net_units_prior,
         COALESCE(SUM(CASE WHEN transaction_date >= @kpiPeriodStart AND transaction_date <= @kpiPeriodEnd THEN signed_gross_dollars ELSE 0 END), 0) AS net_gross_dollars_period,
         COALESCE(SUM(CASE WHEN transaction_date >= @kpiPriorStart  AND transaction_date <= @kpiPriorEnd  THEN signed_gross_dollars ELSE 0 END), 0) AS net_gross_dollars_prior,
         COUNT(DISTINCT CASE WHEN transaction_date >= @kpiPeriodStart AND transaction_date <= @kpiPeriodEnd AND account_key IS NOT NULL THEN account_key END) AS accounts_mapped,
         COUNT(DISTINCT CASE WHEN transaction_date >= @kpiPeriodStart AND transaction_date <= @kpiPeriodEnd AND account_key IS NULL THEN distributor_account_id END) AS accounts_unmapped
       FROM gold.fact_sale f
       WHERE f.tenant_id = @tenantId
         AND f.transaction_date >= @kpiPriorStart
         AND f.transaction_date <= @kpiPeriodEnd
         ${scopeSql(salesScope)}
         ${territorySalesFilter(filters)}`,
      {
        ...params,
        kpiPeriodStart: periodStart,
        kpiPeriodEnd: periodEnd,
        kpiPriorStart: priorStart,
        kpiPriorEnd: priorEnd,
      },
    );
    return rows[0] ?? emptySalesKpis();
  } catch {
    return emptySalesKpis();
  }
}

// ---------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------

export type SalesTrendPoint = {
  bucket_start: string;
  bucket_label: string;
  net_dollars: number;
  net_units: number;
};

function bucketSqlFragments(g: Granularity): {
  anchorSql: string;
  stepUnit: "WEEK" | "MONTH" | "QUARTER";
  addOneSql: string;
} {
  if (g === "week") {
    return {
      anchorSql: `DATEADD(DAY, -((DATEDIFF(DAY, '1900-01-01', CAST(GETDATE() AS date))) % 7), CAST(GETDATE() AS date))`,
      stepUnit: "WEEK",
      addOneSql: `DATEADD(WEEK, 1, b.bucket_start)`,
    };
  }
  if (g === "month") {
    return {
      anchorSql: `DATEFROMPARTS(YEAR(GETDATE()), MONTH(GETDATE()), 1)`,
      stepUnit: "MONTH",
      addOneSql: `DATEADD(MONTH, 1, b.bucket_start)`,
    };
  }
  return {
    anchorSql: `DATEFROMPARTS(YEAR(GETDATE()), ((MONTH(GETDATE()) - 1) / 3) * 3 + 1, 1)`,
    stepUnit: "QUARTER",
    addOneSql: `DATEADD(QUARTER, 1, b.bucket_start)`,
  };
}

function bucketLabel(isoBucketStart: string, g: Granularity): string {
  const d = new Date(isoBucketStart);
  if (g === "week") {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  if (g === "month") {
    return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
  }
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `Q${q} ${String(d.getUTCFullYear()).slice(-2)}`;
}

export async function loadSalesTrend(
  tenantId: string,
  filters: DashboardFilters,
  scope: Scope = NO_SCOPE,
): Promise<SalesTrendPoint[]> {
  try {
    const salesScope = rewriteScopeForSales(scope);
    const buckets = chartBuckets(filters);
    const { anchorSql, stepUnit, addOneSql } = bucketSqlFragments(filters.granularity);
    const valuesList = Array.from({ length: buckets }, (_, i) => `(${i})`).join(",");

    const rows = await queryFabric<{
      bucket_start: string;
      net_dollars: number;
      net_units: number;
    }>(
      tenantId,
      `WITH anchor AS (
         SELECT ${anchorSql} AS this_bucket
       ),
       buckets AS (
         SELECT DATEADD(${stepUnit}, -n, a.this_bucket) AS bucket_start
         FROM anchor a
         CROSS JOIN (VALUES ${valuesList}) AS w(n)
       )
       SELECT
         CONVERT(varchar(10), b.bucket_start, 23) AS bucket_start,
         COALESCE(SUM(f.signed_gross_dollars), 0) AS net_dollars,
         COALESCE(SUM(f.signed_units), 0) AS net_units
       FROM buckets b
       LEFT JOIN gold.fact_sale f
         ON f.tenant_id = @tenantId
         AND f.transaction_date >= b.bucket_start
         AND f.transaction_date < ${addOneSql}
         ${scopeSql(salesScope)}
         ${territorySalesFilter(filters)}
       GROUP BY b.bucket_start
       ORDER BY b.bucket_start ASC`,
      { ...filtersToParams(filters), ...salesScope.params },
    );

    return rows.map((r) => ({
      bucket_start: r.bucket_start,
      bucket_label: bucketLabel(r.bucket_start, filters.granularity),
      net_dollars: Number(r.net_dollars) || 0,
      net_units: Number(r.net_units) || 0,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Top unmapped distributors (the "work-to-do" surface for /admin/mappings)
// ---------------------------------------------------------------------------

export type TopUnmappedDistributor = {
  distributor_account_id: string;
  distributor_account_name: string | null;
  account_state: string | null;
  rows: number;
  net_units: number;
  net_gross_dollars: number;
  last_seen: string | null;
};

export async function loadTopUnmappedDistributors(
  tenantId: string,
  filters: DashboardFilters,
  limit = 10,
): Promise<TopUnmappedDistributor[]> {
  try {
    // Unmapped distributors don't have a territory by definition (no
    // account_key, no bridge → no territory_key). When the user has
    // narrowed to a specific territory, suppress this surface entirely
    // rather than silently showing tenant-wide unmapped totals.
    if (filters.territory) return [];
    const dates = rangeDates(filters.range);
    const dateFilter = dates
      ? `AND transaction_date >= @filterStart AND transaction_date <= @filterEnd`
      : "";
    return await queryFabric<TopUnmappedDistributor>(
      tenantId,
      `SELECT TOP ${limit}
         distributor_account_id,
         MAX(distributor_account_name) AS distributor_account_name,
         MAX(account_state) AS account_state,
         COUNT(*) AS rows,
         ROUND(SUM(signed_units), 0) AS net_units,
         ROUND(SUM(signed_gross_dollars), 0) AS net_gross_dollars,
         CONVERT(varchar(10), MAX(transaction_date), 23) AS last_seen
       FROM gold.fact_sale
       WHERE tenant_id = @tenantId
         AND account_key IS NULL
         AND distributor_account_id IS NOT NULL
         ${dateFilter}
       GROUP BY distributor_account_id
       ORDER BY ABS(SUM(signed_units)) DESC`,
      filtersToParams(filters),
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Top HCOs by Net Sales (with an "Unmapped" pseudo-row so unmapped sales
// stay visible alongside resolved ones — see project memory:
// project_unmapped_sales_visibility.md).
//
// Returns up to `limit` rows total. Mapped HCOs come from a JOIN to
// dim_hco; the unmapped pool is a single synthetic row with hco_key=null
// and a count of distinct distributors so the admin sees the scale of
// what's still unattributed. Sorted naturally by abs(net_gross_dollars)
// descending — the unmapped row is NOT pinned to the bottom.
// ---------------------------------------------------------------------------

export type TopHcoBySales = {
  // null marks the synthetic "Unmapped" row.
  hco_key: string | null;
  name: string;
  hco_type: string | null;
  city: string | null;
  state: string | null;
  net_gross_dollars: number;
  net_units: number;
  rows: number;
  // Only populated on the Unmapped row (count of distinct distributor IDs
  // contributing to the pool). null on regular HCO rows.
  distributor_count: number | null;
};

export async function loadTopHcosBySales(
  tenantId: string,
  filters: DashboardFilters,
  limit = 10,
  scope: Scope = NO_SCOPE,
): Promise<TopHcoBySales[]> {
  try {
    const salesScope = rewriteScopeForSales(scope);
    const dates = rangeDates(filters.range);
    const dateFilter = dates
      ? `AND f.transaction_date >= @filterStart AND f.transaction_date <= @filterEnd`
      : "";
    const params = { ...filtersToParams(filters), ...salesScope.params };

    const [mapped, unmappedAgg] = await Promise.all([
      queryFabric<{
        hco_key: string;
        name: string;
        hco_type: string | null;
        city: string | null;
        state: string | null;
        net_gross_dollars: number;
        net_units: number;
        rows: number;
      }>(
        tenantId,
        // Over-fetch by a small margin so the unmapped row can land
        // anywhere in the displayed top-N without dropping a real HCO.
        // Sort by units (the operational metric pharma reps think in);
        // dollars stay as secondary detail on the rendered table.
        `SELECT TOP ${limit + 1}
           h.hco_key,
           h.name,
           h.hco_type,
           h.city,
           h.state,
           ROUND(SUM(f.signed_gross_dollars), 0) AS net_gross_dollars,
           ROUND(SUM(f.signed_units), 0) AS net_units,
           COUNT(*) AS rows
         FROM gold.fact_sale f
         JOIN gold.dim_hco h
           ON h.hco_key = f.account_key
           AND h.tenant_id = @tenantId
         WHERE f.tenant_id = @tenantId
           AND f.account_type = 'HCO'
           ${dateFilter}
           ${scopeSql(salesScope)}
           ${territorySalesFilter(filters)}
         GROUP BY h.hco_key, h.name, h.hco_type, h.city, h.state
         ORDER BY ABS(SUM(f.signed_units)) DESC`,
        params,
      ),
      queryFabric<{
        net_gross_dollars: number | null;
        net_units: number | null;
        rows: number;
        distributor_count: number;
      }>(
        tenantId,
        // Unmapped pseudo-row: when a territory filter is set, these
        // rows have NULL territory_key and the AND filter naturally
        // returns 0 — pseudo-row drops out, which is the right
        // behavior (unmapped sales aren't "in" any territory).
        `SELECT
           ROUND(SUM(f.signed_gross_dollars), 0) AS net_gross_dollars,
           ROUND(SUM(f.signed_units), 0) AS net_units,
           COUNT(*) AS rows,
           COUNT(DISTINCT f.distributor_account_id) AS distributor_count
         FROM gold.fact_sale f
         WHERE f.tenant_id = @tenantId
           AND f.account_key IS NULL
           AND f.distributor_account_id IS NOT NULL
           ${dateFilter}
           ${scopeSql(salesScope)}
           ${territorySalesFilter(filters)}`,
        params,
      ),
    ]);

    const combined: TopHcoBySales[] = mapped.map((r) => ({
      hco_key: r.hco_key,
      name: r.name,
      hco_type: r.hco_type,
      city: r.city,
      state: r.state,
      net_gross_dollars: Number(r.net_gross_dollars) || 0,
      net_units: Number(r.net_units) || 0,
      rows: Number(r.rows) || 0,
      distributor_count: null,
    }));

    const unmappedRow = unmappedAgg[0];
    if (unmappedRow && Number(unmappedRow.rows) > 0) {
      combined.push({
        hco_key: null,
        name: "Unmapped distributors",
        hco_type: null,
        city: null,
        state: null,
        net_gross_dollars: Number(unmappedRow.net_gross_dollars) || 0,
        net_units: Number(unmappedRow.net_units) || 0,
        rows: Number(unmappedRow.rows) || 0,
        distributor_count: Number(unmappedRow.distributor_count) || 0,
      });
    }

    // Sort naturally by absolute net dollars; the Unmapped row appears
    // wherever its dollar magnitude places it (NOT pinned to the bottom).
    // Units-first sort (matches SQL ORDER BY signed_units). Unmapped
    // pseudo-row ranks naturally by units alongside real HCOs.
    combined.sort(
      (a, b) => Math.abs(b.net_units) - Math.abs(a.net_units),
    );
    return combined.slice(0, limit);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Account motion: HCOs whose net units this period materially changed
// vs the equivalent prior period. Two directions share one loader:
//   "rising"    — period units > prior units (positive delta), top-N
//   "declining" — period units < prior units (negative delta), top-N
//
// Both filter to accounts with sales in BOTH periods. Stop-outs
// (prior > 0, period = 0) belong to the watch list; net-new accounts
// (prior = 0, period > 0) belong to the new-accounts trend. Keeping
// the surfaces non-overlapping makes them mutually exclusive on the
// dashboard so the same HCO doesn't show up in three places.
//
// "All" range returns empty — period-over-period requires a window.
// Unmapped distributors aren't in this view (no HCO identity to rank
// by); the unmapped pseudo-row on Top HCOs by Units already surfaces
// the magnitude.
// ---------------------------------------------------------------------------

export type AccountMotionRow = {
  hco_key: string;
  name: string;
  hco_type: string | null;
  city: string | null;
  state: string | null;
  units_period: number;
  units_prior: number;
  units_delta: number;
  // Null when prior was zero or negative (no meaningful pct base). UI
  // shows a dash; the absolute delta is the operational signal anyway.
  units_delta_pct: number | null;
  dollars_period: number;
  dollars_prior: number;
};

export async function loadAccountMotion(
  tenantId: string,
  filters: DashboardFilters,
  direction: "rising" | "declining",
  limit = 10,
  scope: Scope = NO_SCOPE,
): Promise<AccountMotionRow[]> {
  try {
    const dates = rangeDates(filters.range);
    if (!dates) return []; // "all" range — no period-over-period possible.
    const days = rangeDays(filters.range)!;
    const periodStart = dates.start;
    const periodEnd = dates.end;
    const priorStart = isoDateMinusDays(periodStart, days);
    const priorEnd = isoDateMinusDays(periodStart, 1);

    const salesScope = rewriteScopeForSales(scope);
    const params = {
      ...filtersToParams(filters),
      ...salesScope.params,
      motionPeriodStart: periodStart,
      motionPeriodEnd: periodEnd,
      motionPriorStart: priorStart,
      motionPriorEnd: priorEnd,
    };

    // Order by signed delta. Rising = largest positive first (DESC);
    // declining = largest negative first (ASC). The HAVING clause
    // excludes rows that don't fit the direction so the top-N isn't
    // diluted by flat-or-opposite-direction movers.
    const orderDir = direction === "rising" ? "DESC" : "ASC";
    const havingClause =
      direction === "rising"
        ? "HAVING SUM(CASE WHEN f.transaction_date >= @motionPeriodStart AND f.transaction_date <= @motionPeriodEnd THEN f.signed_units ELSE 0 END) > 0 AND SUM(CASE WHEN f.transaction_date >= @motionPriorStart AND f.transaction_date <= @motionPriorEnd THEN f.signed_units ELSE 0 END) > 0 AND SUM(CASE WHEN f.transaction_date >= @motionPeriodStart AND f.transaction_date <= @motionPeriodEnd THEN f.signed_units ELSE 0 END) > SUM(CASE WHEN f.transaction_date >= @motionPriorStart AND f.transaction_date <= @motionPriorEnd THEN f.signed_units ELSE 0 END)"
        : "HAVING SUM(CASE WHEN f.transaction_date >= @motionPriorStart AND f.transaction_date <= @motionPriorEnd THEN f.signed_units ELSE 0 END) > 0 AND SUM(CASE WHEN f.transaction_date >= @motionPeriodStart AND f.transaction_date <= @motionPeriodEnd THEN f.signed_units ELSE 0 END) > 0 AND SUM(CASE WHEN f.transaction_date >= @motionPeriodStart AND f.transaction_date <= @motionPeriodEnd THEN f.signed_units ELSE 0 END) < SUM(CASE WHEN f.transaction_date >= @motionPriorStart AND f.transaction_date <= @motionPriorEnd THEN f.signed_units ELSE 0 END)";

    const rows = await queryFabric<{
      hco_key: string;
      name: string;
      hco_type: string | null;
      city: string | null;
      state: string | null;
      units_period: number;
      units_prior: number;
      dollars_period: number;
      dollars_prior: number;
    }>(
      tenantId,
      `SELECT TOP ${limit}
         h.hco_key,
         h.name,
         h.hco_type,
         h.city,
         h.state,
         ROUND(SUM(CASE WHEN f.transaction_date >= @motionPeriodStart AND f.transaction_date <= @motionPeriodEnd THEN f.signed_units ELSE 0 END), 0) AS units_period,
         ROUND(SUM(CASE WHEN f.transaction_date >= @motionPriorStart  AND f.transaction_date <= @motionPriorEnd  THEN f.signed_units ELSE 0 END), 0) AS units_prior,
         ROUND(SUM(CASE WHEN f.transaction_date >= @motionPeriodStart AND f.transaction_date <= @motionPeriodEnd THEN f.signed_gross_dollars ELSE 0 END), 0) AS dollars_period,
         ROUND(SUM(CASE WHEN f.transaction_date >= @motionPriorStart  AND f.transaction_date <= @motionPriorEnd  THEN f.signed_gross_dollars ELSE 0 END), 0) AS dollars_prior
       FROM gold.fact_sale f
       JOIN gold.dim_hco h
         ON h.hco_key = f.account_key
         AND h.tenant_id = @tenantId
       WHERE f.tenant_id = @tenantId
         AND f.account_type = 'HCO'
         AND f.transaction_date >= @motionPriorStart
         AND f.transaction_date <= @motionPeriodEnd
         ${scopeSql(salesScope)}
         ${territorySalesFilter(filters)}
       GROUP BY h.hco_key, h.name, h.hco_type, h.city, h.state
       ${havingClause}
       ORDER BY (
         SUM(CASE WHEN f.transaction_date >= @motionPeriodStart AND f.transaction_date <= @motionPeriodEnd THEN f.signed_units ELSE 0 END)
         - SUM(CASE WHEN f.transaction_date >= @motionPriorStart AND f.transaction_date <= @motionPriorEnd THEN f.signed_units ELSE 0 END)
       ) ${orderDir}`,
      params,
    );

    return rows.map((r) => {
      const period = Number(r.units_period) || 0;
      const prior = Number(r.units_prior) || 0;
      const delta = period - prior;
      const pct = prior > 0 ? (delta / prior) * 100 : null;
      return {
        hco_key: r.hco_key,
        name: r.name,
        hco_type: r.hco_type,
        city: r.city,
        state: r.state,
        units_period: period,
        units_prior: prior,
        units_delta: delta,
        units_delta_pct: pct,
        dollars_period: Number(r.dollars_period) || 0,
        dollars_prior: Number(r.dollars_prior) || 0,
      };
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Watch list: HCOs that had sales in the prior equal-length window and
// ZERO sales in the current period. Pharma daily-action surface — "who
// fell off this quarter that we need to chase." Sorted by prior-period
// units (biggest stop-outs first). Surfaces current primary rep so the
// action is unambiguous.
//
// Like loadAccountMotion: requires a real range (returns empty for
// "all"); HCO-only (unmapped distributors are a different action and
// covered by /admin/mappings).
// ---------------------------------------------------------------------------

export type WatchListRow = {
  hco_key: string;
  name: string;
  hco_type: string | null;
  city: string | null;
  state: string | null;
  units_prior: number;
  dollars_prior: number;
  // ISO date of the most recent sale ever (not just within the prior
  // window). Useful to show "last seen 4 months ago" so admins gauge
  // how cold the relationship is.
  last_sale_date: string | null;
  // Resolved primary-territory current rep — same chain as fact_sale
  // attribution. Null when the HCO isn't bridged to any territory or
  // the primary territory has no current Sales rep.
  current_rep_user_key: string | null;
  current_rep_name: string | null;
};

export async function loadWatchListAccounts(
  tenantId: string,
  filters: DashboardFilters,
  limit = 10,
  scope: Scope = NO_SCOPE,
): Promise<WatchListRow[]> {
  try {
    const dates = rangeDates(filters.range);
    if (!dates) return [];
    const days = rangeDays(filters.range)!;
    const periodStart = dates.start;
    const periodEnd = dates.end;
    const priorStart = isoDateMinusDays(periodStart, days);
    const priorEnd = isoDateMinusDays(periodStart, 1);

    const salesScope = rewriteScopeForSales(scope);
    const params = {
      ...filtersToParams(filters),
      ...salesScope.params,
      watchPeriodStart: periodStart,
      watchPeriodEnd: periodEnd,
      watchPriorStart: priorStart,
      watchPriorEnd: priorEnd,
    };

    const rows = await queryFabric<{
      hco_key: string;
      name: string;
      hco_type: string | null;
      city: string | null;
      state: string | null;
      units_prior: number;
      dollars_prior: number;
      last_sale_date: string | null;
      current_rep_user_key: string | null;
      current_rep_name: string | null;
    }>(
      tenantId,
      `WITH activity AS (
         SELECT
           h.hco_key,
           h.name,
           h.hco_type,
           h.city,
           h.state,
           ROUND(SUM(CASE WHEN f.transaction_date >= @watchPeriodStart AND f.transaction_date <= @watchPeriodEnd THEN f.signed_units ELSE 0 END), 0) AS units_period,
           ROUND(SUM(CASE WHEN f.transaction_date >= @watchPriorStart  AND f.transaction_date <= @watchPriorEnd  THEN f.signed_units ELSE 0 END), 0) AS units_prior,
           ROUND(SUM(CASE WHEN f.transaction_date >= @watchPriorStart  AND f.transaction_date <= @watchPriorEnd  THEN f.signed_gross_dollars ELSE 0 END), 0) AS dollars_prior,
           CONVERT(varchar(10), MAX(f.transaction_date), 23) AS last_sale_date
         FROM gold.fact_sale f
         JOIN gold.dim_hco h
           ON h.hco_key = f.account_key
           AND h.tenant_id = @tenantId
         WHERE f.tenant_id = @tenantId
           AND f.account_type = 'HCO'
           AND f.transaction_date <= @watchPeriodEnd
           ${scopeSql(salesScope)}
           ${territorySalesFilter(filters)}
         GROUP BY h.hco_key, h.name, h.hco_type, h.city, h.state
       )
       SELECT TOP ${limit}
         a.hco_key, a.name, a.hco_type, a.city, a.state,
         a.units_prior, a.dollars_prior, a.last_sale_date,
         t.current_rep_user_key,
         t.current_rep_name
       FROM activity a
       LEFT JOIN gold.bridge_account_territory b
         ON b.tenant_id = @tenantId
         AND b.account_key = a.hco_key
         AND CAST(b.is_primary AS INT) = 1
       LEFT JOIN gold.dim_territory t
         ON t.tenant_id = b.tenant_id
         AND t.territory_key = b.territory_key
       WHERE a.units_prior > 0 AND a.units_period = 0
       ORDER BY a.units_prior DESC`,
      params,
    );

    return rows.map((r) => ({
      hco_key: r.hco_key,
      name: r.name,
      hco_type: r.hco_type,
      city: r.city,
      state: r.state,
      units_prior: Number(r.units_prior) || 0,
      dollars_prior: Number(r.dollars_prior) || 0,
      last_sale_date: r.last_sale_date,
      current_rep_user_key: r.current_rep_user_key,
      current_rep_name: r.current_rep_name,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// New accounts: HCOs whose FIRST-EVER sale falls inside the current
// period. Sorted by units in the period (biggest new wins first) so the
// list highlights material new business, not just net-count.
//
// "All" range returns empty — "first sale ever" needs a window to
// land in.
// ---------------------------------------------------------------------------

export type NewAccountRow = {
  hco_key: string;
  name: string;
  hco_type: string | null;
  city: string | null;
  state: string | null;
  first_sale_date: string;
  units_period: number;
  dollars_period: number;
  current_rep_user_key: string | null;
  current_rep_name: string | null;
};

export async function loadNewAccounts(
  tenantId: string,
  filters: DashboardFilters,
  limit = 10,
  scope: Scope = NO_SCOPE,
): Promise<NewAccountRow[]> {
  try {
    const dates = rangeDates(filters.range);
    if (!dates) return [];
    const periodStart = dates.start;
    const periodEnd = dates.end;

    const salesScope = rewriteScopeForSales(scope);
    const params = {
      ...filtersToParams(filters),
      ...salesScope.params,
      newPeriodStart: periodStart,
      newPeriodEnd: periodEnd,
    };

    const rows = await queryFabric<{
      hco_key: string;
      name: string;
      hco_type: string | null;
      city: string | null;
      state: string | null;
      first_sale_date: string;
      units_period: number;
      dollars_period: number;
      current_rep_user_key: string | null;
      current_rep_name: string | null;
    }>(
      tenantId,
      `WITH first_sale AS (
         SELECT
           h.hco_key,
           h.name,
           h.hco_type,
           h.city,
           h.state,
           MIN(f.transaction_date) AS first_sale_date,
           ROUND(SUM(CASE WHEN f.transaction_date >= @newPeriodStart AND f.transaction_date <= @newPeriodEnd THEN f.signed_units ELSE 0 END), 0) AS units_period,
           ROUND(SUM(CASE WHEN f.transaction_date >= @newPeriodStart AND f.transaction_date <= @newPeriodEnd THEN f.signed_gross_dollars ELSE 0 END), 0) AS dollars_period
         FROM gold.fact_sale f
         JOIN gold.dim_hco h
           ON h.hco_key = f.account_key
           AND h.tenant_id = @tenantId
         WHERE f.tenant_id = @tenantId
           AND f.account_type = 'HCO'
           AND f.transaction_date <= @newPeriodEnd
           ${scopeSql(salesScope)}
           ${territorySalesFilter(filters)}
         GROUP BY h.hco_key, h.name, h.hco_type, h.city, h.state
       )
       SELECT TOP ${limit}
         fs.hco_key, fs.name, fs.hco_type, fs.city, fs.state,
         CONVERT(varchar(10), fs.first_sale_date, 23) AS first_sale_date,
         fs.units_period,
         fs.dollars_period,
         t.current_rep_user_key,
         t.current_rep_name
       FROM first_sale fs
       LEFT JOIN gold.bridge_account_territory b
         ON b.tenant_id = @tenantId
         AND b.account_key = fs.hco_key
         AND CAST(b.is_primary AS INT) = 1
       LEFT JOIN gold.dim_territory t
         ON t.tenant_id = b.tenant_id
         AND t.territory_key = b.territory_key
       WHERE fs.first_sale_date >= @newPeriodStart
         AND fs.first_sale_date <= @newPeriodEnd
       ORDER BY fs.units_period DESC, fs.first_sale_date ASC`,
      params,
    );

    return rows.map((r) => ({
      hco_key: r.hco_key,
      name: r.name,
      hco_type: r.hco_type,
      city: r.city,
      state: r.state,
      first_sale_date: r.first_sale_date,
      units_period: Number(r.units_period) || 0,
      dollars_period: Number(r.dollars_period) || 0,
      current_rep_user_key: r.current_rep_user_key,
      current_rep_name: r.current_rep_name,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// HCO-scoped loaders for /hcos/[hco_key] detail page sales surfaces.
// All filter on `account_key = hcoKey AND account_type = 'HCO'`. Returns
// empties on any error (gold.fact_sale not built yet, HCO has zero sales,
// etc.) so the detail page still renders the calls section even when
// sales data isn't there.
// ---------------------------------------------------------------------------

export type HcoSalesKpis = {
  net_units_period: number;
  net_units_prior: number;
  net_gross_dollars_period: number;
  net_gross_dollars_prior: number;
  // ISO date of the most recent transaction across all history (NOT just
  // the selected window) — same "when did anything last happen" semantic
  // as last_call on the calls KPIs.
  last_sale: string | null;
};

function emptyHcoSalesKpis(): HcoSalesKpis {
  return {
    net_units_period: 0,
    net_units_prior: 0,
    net_gross_dollars_period: 0,
    net_gross_dollars_prior: 0,
    last_sale: null,
  };
}

export async function loadHcoSalesKpis(
  tenantId: string,
  hcoKey: string,
  filters: DashboardFilters,
  scope: Scope = NO_SCOPE,
): Promise<HcoSalesKpis> {
  try {
    const salesScope = rewriteScopeForSales(scope);
    const dates = rangeDates(filters.range);
    if (!dates) {
      const rows = await queryFabric<HcoSalesKpis>(
        tenantId,
        `SELECT
           COALESCE(SUM(signed_units), 0) AS net_units_period,
           0 AS net_units_prior,
           COALESCE(SUM(signed_gross_dollars), 0) AS net_gross_dollars_period,
           0 AS net_gross_dollars_prior,
           CONVERT(varchar(10), MAX(transaction_date), 23) AS last_sale
         FROM gold.fact_sale f
         WHERE f.tenant_id = @tenantId
           AND f.account_key = @hcoKey
           AND f.account_type = 'HCO'
           ${scopeSql(salesScope)}`,
        { hcoKey, ...salesScope.params },
      );
      return rows[0] ?? emptyHcoSalesKpis();
    }

    const days = rangeDays(filters.range)!;
    const periodStart = dates.start;
    const periodEnd = dates.end;
    const priorStart = isoDateMinusDays(periodStart, days);
    const priorEnd = isoDateMinusDays(periodStart, 1);

    const rows = await queryFabric<HcoSalesKpis>(
      tenantId,
      `WITH all_history AS (
         SELECT MAX(f.transaction_date) AS last_sale
         FROM gold.fact_sale f
         WHERE f.tenant_id = @tenantId
           AND f.account_key = @hcoKey
           AND f.account_type = 'HCO'
           ${scopeSql(salesScope)}
       )
       SELECT
         COALESCE(SUM(CASE WHEN f.transaction_date >= @kpiPeriodStart AND f.transaction_date <= @kpiPeriodEnd THEN f.signed_units ELSE 0 END), 0) AS net_units_period,
         COALESCE(SUM(CASE WHEN f.transaction_date >= @kpiPriorStart  AND f.transaction_date <= @kpiPriorEnd  THEN f.signed_units ELSE 0 END), 0) AS net_units_prior,
         COALESCE(SUM(CASE WHEN f.transaction_date >= @kpiPeriodStart AND f.transaction_date <= @kpiPeriodEnd THEN f.signed_gross_dollars ELSE 0 END), 0) AS net_gross_dollars_period,
         COALESCE(SUM(CASE WHEN f.transaction_date >= @kpiPriorStart  AND f.transaction_date <= @kpiPriorEnd  THEN f.signed_gross_dollars ELSE 0 END), 0) AS net_gross_dollars_prior,
         CONVERT(varchar(10), (SELECT last_sale FROM all_history), 23) AS last_sale
       FROM gold.fact_sale f
       WHERE f.tenant_id = @tenantId
         AND f.account_key = @hcoKey
         AND f.account_type = 'HCO'
         AND f.transaction_date >= @kpiPriorStart
         AND f.transaction_date <= @kpiPeriodEnd
         ${scopeSql(salesScope)}`,
      {
        hcoKey,
        kpiPeriodStart: periodStart,
        kpiPeriodEnd: periodEnd,
        kpiPriorStart: priorStart,
        kpiPriorEnd: priorEnd,
        ...salesScope.params,
      },
    );
    return rows[0] ?? emptyHcoSalesKpis();
  } catch {
    return emptyHcoSalesKpis();
  }
}

export async function loadHcoSalesTrend(
  tenantId: string,
  hcoKey: string,
  filters: DashboardFilters,
  scope: Scope = NO_SCOPE,
): Promise<SalesTrendPoint[]> {
  try {
    const salesScope = rewriteScopeForSales(scope);
    const buckets = chartBuckets(filters);
    const { anchorSql, stepUnit, addOneSql } = bucketSqlFragments(filters.granularity);
    const valuesList = Array.from({ length: buckets }, (_, i) => `(${i})`).join(",");

    const rows = await queryFabric<{
      bucket_start: string;
      net_dollars: number;
      net_units: number;
    }>(
      tenantId,
      `WITH anchor AS (
         SELECT ${anchorSql} AS this_bucket
       ),
       buckets AS (
         SELECT DATEADD(${stepUnit}, -n, a.this_bucket) AS bucket_start
         FROM anchor a
         CROSS JOIN (VALUES ${valuesList}) AS w(n)
       )
       SELECT
         CONVERT(varchar(10), b.bucket_start, 23) AS bucket_start,
         COALESCE(SUM(f.signed_gross_dollars), 0) AS net_dollars,
         COALESCE(SUM(f.signed_units), 0) AS net_units
       FROM buckets b
       LEFT JOIN gold.fact_sale f
         ON f.tenant_id = @tenantId
         AND f.account_key = @hcoKey
         AND f.account_type = 'HCO'
         AND f.transaction_date >= b.bucket_start
         AND f.transaction_date < ${addOneSql}
         ${scopeSql(salesScope)}
       GROUP BY b.bucket_start
       ORDER BY b.bucket_start ASC`,
      { hcoKey, ...salesScope.params },
    );

    return rows.map((r) => ({
      bucket_start: r.bucket_start,
      bucket_label: bucketLabel(r.bucket_start, filters.granularity),
      net_dollars: Number(r.net_dollars) || 0,
      net_units: Number(r.net_units) || 0,
    }));
  } catch {
    return [];
  }
}

export type HcoTopProduct = {
  product_name: string | null;
  product_ndc: string | null;
  brand: string | null;
  net_gross_dollars: number;
  net_units: number;
  rows: number;
};

// Top products for one HCO over the filter window. Groups by NDC when
// present (most stable identifier), falls back to product_name. Brand is
// kept as denormalized context. No dim_product yet — see sales pipeline
// memory: "no gold.dim_product yet — sales rows carry product_ndc /
// product_name denormalized."
export async function loadHcoTopProducts(
  tenantId: string,
  hcoKey: string,
  filters: DashboardFilters,
  limit = 10,
  scope: Scope = NO_SCOPE,
): Promise<HcoTopProduct[]> {
  try {
    const salesScope = rewriteScopeForSales(scope);
    const dates = rangeDates(filters.range);
    const dateFilter = dates
      ? `AND f.transaction_date >= @filterStart AND f.transaction_date <= @filterEnd`
      : "";
    return await queryFabric<HcoTopProduct>(
      tenantId,
      `SELECT TOP ${limit}
         MAX(f.product_name) AS product_name,
         f.product_ndc,
         MAX(f.brand) AS brand,
         ROUND(SUM(f.signed_gross_dollars), 0) AS net_gross_dollars,
         ROUND(SUM(f.signed_units), 0) AS net_units,
         COUNT(*) AS rows
       FROM gold.fact_sale f
       WHERE f.tenant_id = @tenantId
         AND f.account_key = @hcoKey
         AND f.account_type = 'HCO'
         ${dateFilter}
         ${scopeSql(salesScope)}
       GROUP BY f.product_ndc
       ORDER BY ABS(SUM(f.signed_units)) DESC`,
      { ...filtersToParams(filters), ...salesScope.params, hcoKey },
    );
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Top reps by Net Sales (with an "Unattributed" pseudo-row, mirroring the
// pattern from loadTopHcosBySales).
//
// Three "unattributed" buckets get rolled up into one synthetic row to
// stay simple; the dashboard's existing /admin/pipelines / mapping pages
// already break out unmapped vs no_territory vs no_rep separately. Here
// we just want one number admins can see: "$X.XK of recent sales aren't
// attributed to any rep."
// ---------------------------------------------------------------------------

export type TopRepBySales = {
  rep_user_key: string | null; // null marks the synthetic Unattributed row
  rep_name: string;
  rep_title: string | null;
  net_gross_dollars: number;
  net_units: number;
  rows: number;
  account_count: number | null; // distinct HCOs contributing; null on Unattributed
};

export async function loadTopRepsBySales(
  tenantId: string,
  filters: DashboardFilters,
  limit = 10,
  scope: Scope = NO_SCOPE,
): Promise<TopRepBySales[]> {
  try {
    const salesScope = rewriteScopeForSales(scope);
    const dates = rangeDates(filters.range);
    const dateFilter = dates
      ? `AND f.transaction_date >= @filterStart AND f.transaction_date <= @filterEnd`
      : "";
    const params = { ...filtersToParams(filters), ...salesScope.params };

    const [attributed, unattributedAgg] = await Promise.all([
      queryFabric<{
        rep_user_key: string;
        rep_name: string;
        rep_title: string | null;
        net_gross_dollars: number;
        net_units: number;
        rows: number;
        account_count: number;
      }>(
        tenantId,
        `SELECT TOP ${limit + 1}
           u.user_key AS rep_user_key,
           u.name AS rep_name,
           u.title AS rep_title,
           ROUND(SUM(f.signed_gross_dollars), 0) AS net_gross_dollars,
           ROUND(SUM(f.signed_units), 0) AS net_units,
           COUNT(*) AS rows,
           COUNT(DISTINCT f.account_key) AS account_count
         FROM gold.fact_sale f
         JOIN gold.dim_user u
           ON u.user_key = f.rep_user_key
           AND u.tenant_id = @tenantId
         WHERE f.tenant_id = @tenantId
           AND f.rep_user_key IS NOT NULL
           ${dateFilter}
           ${scopeSql(salesScope)}
           ${territorySalesFilter(filters)}
         GROUP BY u.user_key, u.name, u.title
         ORDER BY ABS(SUM(f.signed_units)) DESC`,
        params,
      ),
      queryFabric<{
        net_gross_dollars: number | null;
        net_units: number | null;
        rows: number;
      }>(
        tenantId,
        `SELECT
           ROUND(SUM(f.signed_gross_dollars), 0) AS net_gross_dollars,
           ROUND(SUM(f.signed_units), 0) AS net_units,
           COUNT(*) AS rows
         FROM gold.fact_sale f
         WHERE f.tenant_id = @tenantId
           AND f.rep_user_key IS NULL
           ${dateFilter}
           ${scopeSql(salesScope)}
           ${territorySalesFilter(filters)}`,
        params,
      ),
    ]);

    const combined: TopRepBySales[] = attributed.map((r) => ({
      rep_user_key: r.rep_user_key,
      rep_name: r.rep_name,
      rep_title: r.rep_title,
      net_gross_dollars: Number(r.net_gross_dollars) || 0,
      net_units: Number(r.net_units) || 0,
      rows: Number(r.rows) || 0,
      account_count: Number(r.account_count) || 0,
    }));

    const unattributedRow = unattributedAgg[0];
    if (unattributedRow && Number(unattributedRow.rows) > 0) {
      combined.push({
        rep_user_key: null,
        rep_name: "Unattributed",
        rep_title: null,
        net_gross_dollars: Number(unattributedRow.net_gross_dollars) || 0,
        net_units: Number(unattributedRow.net_units) || 0,
        rows: Number(unattributedRow.rows) || 0,
        account_count: null,
      });
    }

    combined.sort(
      (a, b) => Math.abs(b.net_units) - Math.abs(a.net_units),
    );
    return combined.slice(0, limit);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Rep-scoped sales loaders (for /reps/[user_key] detail page).
// All filter on `rep_user_key = userKey`. Mirrors HCO-scoped loaders.
// ---------------------------------------------------------------------------

export async function loadRepSalesKpis(
  tenantId: string,
  userKey: string,
  filters: DashboardFilters,
): Promise<HcoSalesKpis> {
  try {
    const dates = rangeDates(filters.range);
    if (!dates) {
      const rows = await queryFabric<HcoSalesKpis>(
        tenantId,
        `SELECT
           COALESCE(SUM(signed_units), 0) AS net_units_period,
           0 AS net_units_prior,
           COALESCE(SUM(signed_gross_dollars), 0) AS net_gross_dollars_period,
           0 AS net_gross_dollars_prior,
           CONVERT(varchar(10), MAX(transaction_date), 23) AS last_sale
         FROM gold.fact_sale
         WHERE tenant_id = @tenantId AND rep_user_key = @userKey`,
        { userKey },
      );
      return rows[0] ?? emptyHcoSalesKpis();
    }
    const days = rangeDays(filters.range)!;
    const periodStart = dates.start;
    const periodEnd = dates.end;
    const priorStart = isoDateMinusDays(periodStart, days);
    const priorEnd = isoDateMinusDays(periodStart, 1);
    const rows = await queryFabric<HcoSalesKpis>(
      tenantId,
      `WITH all_history AS (
         SELECT MAX(transaction_date) AS last_sale
         FROM gold.fact_sale
         WHERE tenant_id = @tenantId AND rep_user_key = @userKey
       )
       SELECT
         COALESCE(SUM(CASE WHEN transaction_date >= @kpiPeriodStart AND transaction_date <= @kpiPeriodEnd THEN signed_units ELSE 0 END), 0) AS net_units_period,
         COALESCE(SUM(CASE WHEN transaction_date >= @kpiPriorStart  AND transaction_date <= @kpiPriorEnd  THEN signed_units ELSE 0 END), 0) AS net_units_prior,
         COALESCE(SUM(CASE WHEN transaction_date >= @kpiPeriodStart AND transaction_date <= @kpiPeriodEnd THEN signed_gross_dollars ELSE 0 END), 0) AS net_gross_dollars_period,
         COALESCE(SUM(CASE WHEN transaction_date >= @kpiPriorStart  AND transaction_date <= @kpiPriorEnd  THEN signed_gross_dollars ELSE 0 END), 0) AS net_gross_dollars_prior,
         CONVERT(varchar(10), (SELECT last_sale FROM all_history), 23) AS last_sale
       FROM gold.fact_sale
       WHERE tenant_id = @tenantId AND rep_user_key = @userKey
         AND transaction_date >= @kpiPriorStart
         AND transaction_date <= @kpiPeriodEnd`,
      {
        userKey,
        kpiPeriodStart: periodStart,
        kpiPeriodEnd: periodEnd,
        kpiPriorStart: priorStart,
        kpiPriorEnd: priorEnd,
      },
    );
    return rows[0] ?? emptyHcoSalesKpis();
  } catch {
    return emptyHcoSalesKpis();
  }
}

export async function loadRepSalesTrend(
  tenantId: string,
  userKey: string,
  filters: DashboardFilters,
): Promise<SalesTrendPoint[]> {
  try {
    const buckets = chartBuckets(filters);
    const { anchorSql, stepUnit, addOneSql } = bucketSqlFragments(filters.granularity);
    const valuesList = Array.from({ length: buckets }, (_, i) => `(${i})`).join(",");
    const rows = await queryFabric<{
      bucket_start: string;
      net_dollars: number;
      net_units: number;
    }>(
      tenantId,
      `WITH anchor AS (SELECT ${anchorSql} AS this_bucket),
       buckets AS (
         SELECT DATEADD(${stepUnit}, -n, a.this_bucket) AS bucket_start
         FROM anchor a CROSS JOIN (VALUES ${valuesList}) AS w(n)
       )
       SELECT
         CONVERT(varchar(10), b.bucket_start, 23) AS bucket_start,
         COALESCE(SUM(f.signed_gross_dollars), 0) AS net_dollars,
         COALESCE(SUM(f.signed_units), 0) AS net_units
       FROM buckets b
       LEFT JOIN gold.fact_sale f
         ON f.tenant_id = @tenantId
         AND f.rep_user_key = @userKey
         AND f.transaction_date >= b.bucket_start
         AND f.transaction_date < ${addOneSql}
       GROUP BY b.bucket_start
       ORDER BY b.bucket_start ASC`,
      { userKey },
    );
    return rows.map((r) => ({
      bucket_start: r.bucket_start,
      bucket_label: bucketLabel(r.bucket_start, filters.granularity),
      net_dollars: Number(r.net_dollars) || 0,
      net_units: Number(r.net_units) || 0,
    }));
  } catch {
    return [];
  }
}

export type RepTopHco = {
  hco_key: string;
  name: string;
  hco_type: string | null;
  city: string | null;
  state: string | null;
  net_gross_dollars: number;
  net_units: number;
  rows: number;
};

// All HCOs the rep covers via ANY territory bridge (Primary OR
// Co-coverage). For Option B's multi-visibility model: rep sees their
// full book of business matching Fennec's coverage view, but sales
// CREDIT still goes to whoever is primary on each HCO. The is_primary
// flag tells which HCOs they actually get credit for.
//
// Note: not date-filtered. Coverage is a current-state concept, not a
// time-window concept. The rep is currently assigned to these HCOs;
// sales attribution within a time window is the separate concern that
// loadRepTopHcos handles.
export type RepCoverageHco = {
  hco_key: string;
  name: string;
  hco_type: string | null;
  city: string | null;
  state: string | null;
  // 1 if this rep is the primary credit-getter for this HCO via the
  // primary territory's current_rep_user_key. 0 if co-coverage only.
  is_primary_for_rep: number;
  // Comma-separated list of territory names through which this rep
  // covers the HCO. Helps the rep see "I cover this via territory X
  // and Y" when they have multiple paths.
  territories_covered: string;
};

export async function loadRepCoverageHcos(
  tenantId: string,
  userKey: string,
  limit = 200,
): Promise<RepCoverageHco[]> {
  try {
    return await queryFabric<RepCoverageHco>(
      tenantId,
      `WITH rep_territories AS (
         -- Territories this rep is actively assigned to in Veeva.
         -- Resolved via dim_user (user_key → veeva_user_id) →
         -- silver.user_territory → gold.dim_territory.
         SELECT
           t.territory_key,
           -- Display label: prefer geographic description (e.g. "Los
           -- Angeles") over Veeva code (e.g. "C103") per
           -- feedback_territory_display. Codes are admin internals; reps
           -- and managers know their territories by region.
           COALESCE(t.description, t.name) AS territory_label
         FROM gold.dim_user u
         JOIN silver.user_territory ut
           ON ut.tenant_id = u.tenant_id
           AND ut.user_id = u.veeva_user_id
           AND COALESCE(ut.status, '') IN ('', 'Active', 'active')
         JOIN gold.dim_territory t
           ON t.tenant_id = ut.tenant_id
           AND t.veeva_territory_id = ut.territory_id
         WHERE u.tenant_id = @tenantId AND u.user_key = @userKey
       ),
       hco_coverage AS (
         -- Every HCO any rep_territory covers, with the territory labels
         -- collected so the UI can show paths of coverage.
         SELECT
           b.account_key,
           STRING_AGG(rt.territory_label, ', ') WITHIN GROUP (ORDER BY rt.territory_label)
             AS territories_covered
         FROM gold.bridge_account_territory b
         JOIN rep_territories rt
           ON rt.territory_key = b.territory_key
         WHERE b.tenant_id = @tenantId
         GROUP BY b.account_key
       )
       SELECT TOP ${limit}
         h.hco_key,
         h.name,
         h.hco_type,
         h.city,
         h.state,
         hc.territories_covered,
         -- Is this rep the primary credit-getter for this HCO? Resolved
         -- by checking if the HCO's primary territory's current rep
         -- equals this user. If so the HCO's sales credit them; if not,
         -- they cover it but credit goes elsewhere.
         CASE
           WHEN EXISTS (
             SELECT 1 FROM gold.bridge_account_territory bp
             JOIN gold.dim_territory tp
               ON tp.tenant_id = bp.tenant_id
               AND tp.territory_key = bp.territory_key
             WHERE bp.tenant_id = @tenantId
               AND bp.account_key = h.hco_key
               AND CAST(bp.is_primary AS INT) = 1
               AND tp.current_rep_user_key = @userKey
           ) THEN 1 ELSE 0
         END AS is_primary_for_rep
       FROM gold.dim_hco h
       JOIN hco_coverage hc ON hc.account_key = h.hco_key
       WHERE h.tenant_id = @tenantId
       ORDER BY is_primary_for_rep DESC, h.name`,
      { userKey },
    );
  } catch {
    return [];
  }
}

// Territories where this rep is currently the primary credit-getter.
// Returns territory_keys so the caller can sum overlapping territory-entity
// goal portions to compute the rep's "effective goal" for sales attainment.
//
// CURRENT-STATE only (matches Phase A fact_sale.rep_user_key resolution):
// uses dim_territory.current_rep_user_key, not point-in-time SCD2 history.
// A mid-period rep change therefore shifts the entire period's goal credit
// to whoever holds the territory today.
export async function loadRepCurrentTerritoryKeys(
  tenantId: string,
  userKey: string,
): Promise<string[]> {
  try {
    const rows = await queryFabric<{ territory_key: string }>(
      tenantId,
      `SELECT territory_key
       FROM gold.dim_territory
       WHERE tenant_id = @tenantId
         AND current_rep_user_key = @userKey
         AND COALESCE(status, '') IN ('', 'Active', 'active')`,
      { userKey },
    );
    return rows.map((r) => r.territory_key);
  } catch {
    return [];
  }
}

// Territories the current user can choose from in the dashboard
// territory filter. Scoped by role:
//   admin/bypass — every active territory
//   manager      — territories whose current Sales rep is in the team
//   rep          — territories where this rep is the current Sales rep
//
// Returns description-first labels (per feedback_territory_display) plus
// the Veeva code as a separate field so the dropdown can render both.
export type AccessibleTerritory = {
  territory_key: string;
  label: string;
  code: string;
};

export async function loadAccessibleTerritories(
  tenantId: string,
  userScope: UserScope,
): Promise<AccessibleTerritory[]> {
  try {
    let whereExtra = "";
    if (userScope.role === "rep") {
      // Single key — bind via parameter so we don't have to escape.
      whereExtra = "AND current_rep_user_key = @scopeUserKey";
    } else if (userScope.role === "manager") {
      if (userScope.userKeys.length === 0) return [];
      // Same inline-IN pattern as scopeToSql() for managers — userKeys
      // come from our own DB so they're trusted; still escape single
      // quotes defensively.
      const sanitized = userScope.userKeys.map(
        (k) => `'${k.replace(/'/g, "''")}'`,
      );
      whereExtra = `AND current_rep_user_key IN (${sanitized.join(",")})`;
    }

    const rows = await queryFabric<{
      territory_key: string;
      name: string;
      description: string | null;
    }>(
      tenantId,
      `SELECT territory_key, name, description
       FROM gold.dim_territory
       WHERE tenant_id = @tenantId
         AND COALESCE(status, '') IN ('', 'Active', 'active')
         ${whereExtra}
       ORDER BY COALESCE(description, name)`,
      userScope.role === "rep" ? { scopeUserKey: userScope.userKey } : {},
    );
    return rows.map((r) => ({
      territory_key: r.territory_key,
      label: r.description ?? r.name,
      code: r.name,
    }));
  } catch {
    return [];
  }
}

export async function loadRepTopHcos(
  tenantId: string,
  userKey: string,
  filters: DashboardFilters,
  limit = 10,
): Promise<RepTopHco[]> {
  try {
    const dates = rangeDates(filters.range);
    const dateFilter = dates
      ? `AND f.transaction_date >= @filterStart AND f.transaction_date <= @filterEnd`
      : "";
    return await queryFabric<RepTopHco>(
      tenantId,
      `SELECT TOP ${limit}
         h.hco_key, h.name, h.hco_type, h.city, h.state,
         ROUND(SUM(f.signed_gross_dollars), 0) AS net_gross_dollars,
         ROUND(SUM(f.signed_units), 0) AS net_units,
         COUNT(*) AS rows
       FROM gold.fact_sale f
       JOIN gold.dim_hco h ON h.hco_key = f.account_key AND h.tenant_id = @tenantId
       WHERE f.tenant_id = @tenantId
         AND f.rep_user_key = @userKey
         AND f.account_type = 'HCO'
         ${dateFilter}
       GROUP BY h.hco_key, h.name, h.hco_type, h.city, h.state
       ORDER BY ABS(SUM(f.signed_units)) DESC`,
      { ...filtersToParams(filters), userKey },
    );
  } catch {
    return [];
  }
}
