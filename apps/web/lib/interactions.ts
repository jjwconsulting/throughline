// Shared gold.fact_call query helpers for the dashboard, rep detail, and
// HCP detail surfaces. All four loaders take an optional `scope` to add
// page-specific filters (rep page: owner_user_key=X; HCP page: hcp_key=Y)
// AND, eventually, RLS-derived clauses (logged-in rep can only see their own
// data — see docs/architecture/rls.md).

import { queryFabric } from "@/lib/fabric";
import {
  filterClauses,
  filtersToParams,
  rangeDates,
  rangeDays,
  chartBuckets,
  type DashboardFilters,
  type Granularity,
} from "@/app/(app)/dashboard/filters";

export type Scope = {
  // SQL fragments concatenated into the WHERE clause; each must start with " AND ".
  clauses: string[];
  // Additional bound parameters required by the clauses.
  params: Record<string, string | number | Date | boolean | null>;
};

export const NO_SCOPE: Scope = { clauses: [], params: {} };

function scopeSql(scope: Scope): string {
  return scope.clauses.join(" ");
}

function mergeParams(
  filters: DashboardFilters,
  scope: Scope,
  extra: Record<string, string | number | Date | boolean | null> = {},
): Record<string, string | number | Date | boolean | null> {
  return { ...filtersToParams(filters), ...scope.params, ...extra };
}

// ---------------------------------------------------------------------------
// KPIs: interactions in the selected period, prior-period delta, distinct
// HCPs reached, distinct reps active.
// ---------------------------------------------------------------------------

export type InteractionKpis = {
  calls_period: number;
  calls_prior: number;
  hcps: number;
  hcos: number;
  reps: number;
  // Most recent call_date across the scoped fact rows, ignoring time filter
  // — pages typically want "when was the last contact, ever" rather than
  // "...within the selected period." Returned as ISO string or null.
  last_call: string | null;
};

export async function loadInteractionKpis(
  tenantId: string,
  filters: DashboardFilters,
  scope: Scope = NO_SCOPE,
): Promise<InteractionKpis> {
  const { channelFilter, accountFilter } = filterClauses(filters);
  const extras = `${channelFilter} ${accountFilter} ${scopeSql(scope)}`;
  const params = mergeParams(filters, scope);

  if (filters.range === "all") {
    const rows = await queryFabric<InteractionKpis>(
      tenantId,
      `SELECT
         COUNT(*) AS calls_period,
         0 AS calls_prior,
         COUNT(DISTINCT f.hcp_key) AS hcps,
         COUNT(DISTINCT f.hco_key) AS hcos,
         COUNT(DISTINCT f.owner_user_key) AS reps,
         CONVERT(varchar(10), MAX(f.call_date), 23) AS last_call
       FROM gold.fact_call f
       WHERE f.tenant_id = @tenantId ${extras}`,
      params,
    );
    return rows[0] ?? emptyKpis();
  }

  // Prior period = same number of days immediately preceding the current
  // window. Works uniformly for rolling (4w) and snap-to-period (mtd/qtd/ytd)
  // ranges since both reduce to a (start, end) tuple.
  const days = rangeDays(filters.range)!;
  const dates = rangeDates(filters.range)!;
  const periodStart = dates.start;
  const periodEnd = dates.end;
  const priorStart = isoDateMinusDays(periodStart, days);
  const priorEnd = isoDateMinusDays(periodStart, 1);

  // last_call is intentionally computed against the unfiltered scope (all
  // history), not the selected period — see InteractionKpis docstring.
  const rows = await queryFabric<InteractionKpis>(
    tenantId,
    `WITH all_scope AS (
       SELECT MAX(call_date) AS last_call
       FROM gold.fact_call f
       WHERE f.tenant_id = @tenantId ${channelFilter} ${accountFilter} ${scopeSql(scope)}
     ),
     window_scope AS (
       SELECT f.call_date, f.hcp_key, f.hco_key, f.owner_user_key
       FROM gold.fact_call f
       WHERE f.tenant_id = @tenantId
         AND f.call_date >= @kpiPriorStart
         AND f.call_date <= @kpiPeriodEnd
         ${channelFilter} ${accountFilter} ${scopeSql(scope)}
     )
     SELECT
       SUM(CASE WHEN w.call_date >= @kpiPeriodStart AND w.call_date <= @kpiPeriodEnd THEN 1 ELSE 0 END) AS calls_period,
       SUM(CASE WHEN w.call_date >= @kpiPriorStart AND w.call_date <= @kpiPriorEnd THEN 1 ELSE 0 END) AS calls_prior,
       COUNT(DISTINCT CASE WHEN w.call_date >= @kpiPeriodStart AND w.call_date <= @kpiPeriodEnd THEN w.hcp_key END) AS hcps,
       COUNT(DISTINCT CASE WHEN w.call_date >= @kpiPeriodStart AND w.call_date <= @kpiPeriodEnd THEN w.hco_key END) AS hcos,
       COUNT(DISTINCT CASE WHEN w.call_date >= @kpiPeriodStart AND w.call_date <= @kpiPeriodEnd THEN w.owner_user_key END) AS reps,
       CONVERT(varchar(10), MAX(a.last_call), 23) AS last_call
     FROM window_scope w CROSS JOIN all_scope a`,
    {
      ...params,
      kpiPeriodStart: periodStart,
      kpiPeriodEnd: periodEnd,
      kpiPriorStart: priorStart,
      kpiPriorEnd: priorEnd,
    },
  );
  return rows[0] ?? emptyKpis();
}

function isoDateMinusDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function emptyKpis(): InteractionKpis {
  return { calls_period: 0, calls_prior: 0, hcps: 0, hcos: 0, reps: 0, last_call: null };
}

// ---------------------------------------------------------------------------
// Trend chart data. Buckets call_date by the filter's granularity:
//   week    — Monday-anchored, 7-day buckets
//   month   — calendar month buckets
//   quarter — calendar quarter buckets
// Bucket count comes from chartBuckets(filters), capped at 24.
// ---------------------------------------------------------------------------

export type TrendPoint = {
  bucket_start: string;
  bucket_label: string;
  calls: number;
};

export async function loadTrend(
  tenantId: string,
  filters: DashboardFilters,
  scope: Scope = NO_SCOPE,
): Promise<TrendPoint[]> {
  const buckets = chartBuckets(filters);
  const { channelFilter, accountFilter } = filterClauses(filters);
  const { anchorSql, stepUnit, addOneSql } = bucketSqlFragments(filters.granularity);
  const valuesList = Array.from({ length: buckets }, (_, i) => `(${i})`).join(",");

  const rows = await queryFabric<{ bucket_start: string; calls: number }>(
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
       COUNT(f.call_key) AS calls
     FROM buckets b
     LEFT JOIN gold.fact_call f
       ON f.tenant_id = @tenantId
       AND f.call_date >= b.bucket_start
       AND f.call_date < ${addOneSql}
       ${channelFilter} ${accountFilter} ${scopeSql(scope)}
     GROUP BY b.bucket_start
     ORDER BY b.bucket_start ASC`,
    mergeParams(filters, scope),
  );

  return rows.map((r) => ({
    bucket_start: r.bucket_start,
    bucket_label: bucketLabel(r.bucket_start, filters.granularity),
    calls: r.calls,
  }));
}

// SQL fragments to generate bucket boundaries per granularity. Anchor is the
// start of the bucket containing TODAY; we DATEADD(stepUnit, -n) to walk back.
function bucketSqlFragments(g: Granularity): {
  anchorSql: string;
  stepUnit: "WEEK" | "MONTH" | "QUARTER";
  addOneSql: string;
} {
  if (g === "week") {
    return {
      // Monday of current week (DATEFIRST-independent: 1900-01-01 was a Monday)
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
  // quarter
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
  // quarter
  const q = Math.floor(d.getUTCMonth() / 3) + 1;
  return `Q${q} ${String(d.getUTCFullYear()).slice(-2)}`;
}

// ---------------------------------------------------------------------------
// Top reps by call count.
// ---------------------------------------------------------------------------

export type TopRep = { user_key: string; name: string; calls: number };

export async function loadTopReps(
  tenantId: string,
  filters: DashboardFilters,
  scope: Scope = NO_SCOPE,
): Promise<TopRep[]> {
  const { dateFilter, channelFilter, accountFilter } = filterClauses(filters);
  return queryFabric<TopRep>(
    tenantId,
    `SELECT TOP 10 u.user_key, u.name, COUNT(*) AS calls
     FROM gold.fact_call f
     JOIN gold.dim_user u ON u.user_key = f.owner_user_key AND u.tenant_id = @tenantId
     WHERE f.tenant_id = @tenantId
       AND u.user_type IN ('Sales', 'Medical')
       ${dateFilter} ${channelFilter} ${accountFilter} ${scopeSql(scope)}
     GROUP BY u.user_key, u.name
     ORDER BY calls DESC`,
    mergeParams(filters, scope),
  );
}

// ---------------------------------------------------------------------------
// Top HCPs by call count.
// ---------------------------------------------------------------------------

export type TopHcp = {
  hcp_key: string;
  name: string;
  specialty: string | null;
  calls: number;
};

export async function loadTopHcps(
  tenantId: string,
  filters: DashboardFilters,
  scope: Scope = NO_SCOPE,
): Promise<TopHcp[]> {
  const { dateFilter, channelFilter, accountFilter } = filterClauses(filters);
  return queryFabric<TopHcp>(
    tenantId,
    `SELECT TOP 10 h.hcp_key, h.name, h.specialty_primary AS specialty, COUNT(*) AS calls
     FROM gold.fact_call f
     JOIN gold.dim_hcp h ON h.hcp_key = f.hcp_key AND h.tenant_id = @tenantId
     WHERE f.tenant_id = @tenantId
       ${dateFilter} ${channelFilter} ${accountFilter} ${scopeSql(scope)}
     GROUP BY h.hcp_key, h.name, h.specialty_primary
     ORDER BY calls DESC`,
    mergeParams(filters, scope),
  );
}

// ---------------------------------------------------------------------------
// Top HCOs by call count.
// ---------------------------------------------------------------------------

export type TopHco = {
  hco_key: string;
  name: string;
  hco_type: string | null;
  city: string | null;
  state: string | null;
  calls: number;
};

export async function loadTopHcos(
  tenantId: string,
  filters: DashboardFilters,
  scope: Scope = NO_SCOPE,
): Promise<TopHco[]> {
  const { dateFilter, channelFilter, accountFilter } = filterClauses(filters);
  return queryFabric<TopHco>(
    tenantId,
    `SELECT TOP 10 h.hco_key, h.name, h.hco_type, h.city, h.state, COUNT(*) AS calls
     FROM gold.fact_call f
     JOIN gold.dim_hco h ON h.hco_key = f.hco_key AND h.tenant_id = @tenantId
     WHERE f.tenant_id = @tenantId
       ${dateFilter} ${channelFilter} ${accountFilter} ${scopeSql(scope)}
     GROUP BY h.hco_key, h.name, h.hco_type, h.city, h.state
     ORDER BY calls DESC`,
    mergeParams(filters, scope),
  );
}

// ---------------------------------------------------------------------------
// Page-specific scope builders.
// ---------------------------------------------------------------------------

export function repScope(userKey: string): Scope {
  return {
    clauses: ["AND f.owner_user_key = @repUserKey"],
    params: { repUserKey: userKey },
  };
}

export function hcpScope(hcpKey: string): Scope {
  return {
    clauses: ["AND f.hcp_key = @hcpHcpKey"],
    params: { hcpHcpKey: hcpKey },
  };
}

export function hcoScope(hcoKey: string): Scope {
  return {
    clauses: ["AND f.hco_key = @hcoHcoKey"],
    params: { hcoHcoKey: hcoKey },
  };
}
