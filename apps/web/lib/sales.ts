// Sales query helpers, mirror of interactions.ts but for gold.fact_sale.
//
// All loaders are wrapped in try/catch so the dashboard still renders if
// gold.fact_sale doesn't exist yet (cold start before the sales pipeline
// runs). Empty results = $0 cards + empty trend, never a 500.
//
// RLS note: gold.fact_sale has no owner_user_key — sales arrive at the
// distributor-account grain, not the rep grain. Until we ship a
// HCP↔territory bridge + rep_user_key resolution, every role in a tenant
// sees the same sales totals. The mapping UI exposes this to admins; reps
// see tenant-wide sales. Acceptable for v1; revisit when territory rollups
// land.

import { queryFabric } from "@/lib/fabric";
import {
  rangeDates,
  rangeDays,
  chartBuckets,
  filtersToParams,
  type DashboardFilters,
  type Granularity,
} from "@/app/(app)/dashboard/filters";

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
): Promise<SalesKpis> {
  try {
    const params = filtersToParams(filters);
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
         FROM gold.fact_sale
         WHERE tenant_id = @tenantId`,
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
       FROM gold.fact_sale
       WHERE tenant_id = @tenantId
         AND transaction_date >= @kpiPriorStart
         AND transaction_date <= @kpiPeriodEnd`,
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
       GROUP BY b.bucket_start
       ORDER BY b.bucket_start ASC`,
      filtersToParams(filters),
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
  net_gross_dollars: number;
  last_seen: string | null;
};

export async function loadTopUnmappedDistributors(
  tenantId: string,
  filters: DashboardFilters,
  limit = 10,
): Promise<TopUnmappedDistributor[]> {
  try {
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
         ROUND(SUM(signed_gross_dollars), 0) AS net_gross_dollars,
         CONVERT(varchar(10), MAX(transaction_date), 23) AS last_seen
       FROM gold.fact_sale
       WHERE tenant_id = @tenantId
         AND account_key IS NULL
         AND distributor_account_id IS NOT NULL
         ${dateFilter}
       GROUP BY distributor_account_id
       ORDER BY net_gross_dollars DESC`,
      filtersToParams(filters),
    );
  } catch {
    return [];
  }
}
