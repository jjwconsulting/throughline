// Shared gold.fact_call query helpers for the dashboard, rep detail, and
// HCP detail surfaces. All four loaders take an optional `scope` to add
// page-specific filters (rep page: owner_user_key=X; HCP page: hcp_key=Y)
// AND, eventually, RLS-derived clauses (logged-in rep can only see their own
// data — see docs/architecture/rls.md).

import { queryFabric } from "@/lib/fabric";
import {
  filterClauses,
  filtersToParams,
  rangeWeeks,
  chartWeeks,
  type DashboardFilters,
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

  const weeks = rangeWeeks(filters.range);
  // last_call is intentionally computed against the unfiltered scope (all
  // history), not the selected period — see InteractionKpis docstring.
  const rows = await queryFabric<InteractionKpis>(
    tenantId,
    `WITH bounds AS (
       SELECT
         CAST(GETDATE() AS date) AS today,
         DATEADD(WEEK, -${weeks}, CAST(GETDATE() AS date)) AS period_start,
         DATEADD(WEEK, -${weeks * 2}, CAST(GETDATE() AS date)) AS prior_start
     ),
     all_scope AS (
       SELECT MAX(call_date) AS last_call
       FROM gold.fact_call f
       WHERE f.tenant_id = @tenantId ${extras}
     ),
     window_scope AS (
       SELECT f.call_date, f.hcp_key, f.hco_key, f.owner_user_key
       FROM gold.fact_call f CROSS JOIN bounds b
       WHERE f.tenant_id = @tenantId
         AND f.call_date >= b.prior_start
         AND f.call_date <= b.today
         ${extras}
     )
     SELECT
       SUM(CASE WHEN w.call_date >= b.period_start AND w.call_date <= b.today THEN 1 ELSE 0 END) AS calls_period,
       SUM(CASE WHEN w.call_date >= b.prior_start AND w.call_date < b.period_start THEN 1 ELSE 0 END) AS calls_prior,
       COUNT(DISTINCT CASE WHEN w.call_date >= b.period_start AND w.call_date <= b.today THEN w.hcp_key END) AS hcps,
       COUNT(DISTINCT CASE WHEN w.call_date >= b.period_start AND w.call_date <= b.today THEN w.hco_key END) AS hcos,
       COUNT(DISTINCT CASE WHEN w.call_date >= b.period_start AND w.call_date <= b.today THEN w.owner_user_key END) AS reps,
       CONVERT(varchar(10), MAX(a.last_call), 23) AS last_call
     FROM window_scope w CROSS JOIN bounds b CROSS JOIN all_scope a`,
    params,
  );
  return rows[0] ?? emptyKpis();
}

function emptyKpis(): InteractionKpis {
  return { calls_period: 0, calls_prior: 0, hcps: 0, hcos: 0, reps: 0, last_call: null };
}

// ---------------------------------------------------------------------------
// Weekly trend chart data. Anchored to Monday of the current calendar week
// (DATEFIRST-independent: 1900-01-01 was a Monday).
// ---------------------------------------------------------------------------

export type WeekPoint = { week_start: string; calls: number };

export async function loadWeeklyTrend(
  tenantId: string,
  filters: DashboardFilters,
  scope: Scope = NO_SCOPE,
): Promise<WeekPoint[]> {
  const buckets = chartWeeks(filters.range);
  const { channelFilter, accountFilter } = filterClauses(filters);
  const valuesList = Array.from({ length: buckets }, (_, i) => `(${i})`).join(",");
  return queryFabric<WeekPoint>(
    tenantId,
    `WITH anchor AS (
       SELECT DATEADD(DAY,
         -((DATEDIFF(DAY, '1900-01-01', CAST(GETDATE() AS date))) % 7),
         CAST(GETDATE() AS date)) AS this_week
     ),
     weeks AS (
       SELECT DATEADD(WEEK, -n, a.this_week) AS week_start
       FROM anchor a
       CROSS JOIN (VALUES ${valuesList}) AS w(n)
     )
     SELECT
       CONVERT(varchar(10), w.week_start, 23) AS week_start,
       COUNT(f.call_key) AS calls
     FROM weeks w
     LEFT JOIN gold.fact_call f
       ON f.tenant_id = @tenantId
       AND f.call_date >= w.week_start
       AND f.call_date < DATEADD(WEEK, 1, w.week_start)
       ${channelFilter} ${accountFilter} ${scopeSql(scope)}
     GROUP BY w.week_start
     ORDER BY w.week_start ASC`,
    mergeParams(filters, scope),
  );
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
