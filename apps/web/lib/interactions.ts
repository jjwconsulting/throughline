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
  // Live-vs-dropoff split for the period. Calculated against the
  // SAME filters as calls_period so the breakdown matches the headline
  // count. When callKind filter is non-'all' these will sum to
  // calls_period (one of them being 0). Surfaced on the KPI card as
  // "X live, Y drop-off" sub-line.
  live_calls_period: number;
  dropoff_calls_period: number;
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
  const { channelFilter, accountFilter, territoryFilter, callKindFilter } =
    filterClauses(filters);
  const extras = `${channelFilter} ${accountFilter} ${territoryFilter} ${callKindFilter} ${scopeSql(scope)}`;
  const params = mergeParams(filters, scope);

  if (filters.range === "all") {
    const rows = await queryFabric<InteractionKpis>(
      tenantId,
      `SELECT
         COUNT(*) AS calls_period,
         0 AS calls_prior,
         SUM(CASE WHEN LOWER(COALESCE(f.drop_off_visit, '')) = 'true' THEN 0 ELSE 1 END) AS live_calls_period,
         SUM(CASE WHEN LOWER(COALESCE(f.drop_off_visit, '')) = 'true' THEN 1 ELSE 0 END) AS dropoff_calls_period,
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
       WHERE f.tenant_id = @tenantId ${channelFilter} ${accountFilter} ${territoryFilter} ${callKindFilter} ${scopeSql(scope)}
     ),
     window_scope AS (
       SELECT f.call_date, f.hcp_key, f.hco_key, f.owner_user_key, f.drop_off_visit
       FROM gold.fact_call f
       WHERE f.tenant_id = @tenantId
         AND f.call_date >= @kpiPriorStart
         AND f.call_date <= @kpiPeriodEnd
         ${channelFilter} ${accountFilter} ${territoryFilter} ${callKindFilter} ${scopeSql(scope)}
     )
     -- COALESCE on SUMs because they return NULL (not 0) when window_scope
     -- is empty for this RLS scope (e.g., a rep visiting an HCO they don't
     -- cover). COUNTs naturally return 0 so no wrap needed there.
     SELECT
       COALESCE(SUM(CASE WHEN w.call_date >= @kpiPeriodStart AND w.call_date <= @kpiPeriodEnd THEN 1 ELSE 0 END), 0) AS calls_period,
       COALESCE(SUM(CASE WHEN w.call_date >= @kpiPriorStart AND w.call_date <= @kpiPriorEnd THEN 1 ELSE 0 END), 0) AS calls_prior,
       COALESCE(SUM(CASE WHEN w.call_date >= @kpiPeriodStart AND w.call_date <= @kpiPeriodEnd
                          AND LOWER(COALESCE(w.drop_off_visit, '')) <> 'true' THEN 1 ELSE 0 END), 0) AS live_calls_period,
       COALESCE(SUM(CASE WHEN w.call_date >= @kpiPeriodStart AND w.call_date <= @kpiPeriodEnd
                          AND LOWER(COALESCE(w.drop_off_visit, '')) = 'true' THEN 1 ELSE 0 END), 0) AS dropoff_calls_period,
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
  return {
    calls_period: 0,
    calls_prior: 0,
    live_calls_period: 0,
    dropoff_calls_period: 0,
    hcps: 0,
    hcos: 0,
    reps: 0,
    last_call: null,
  };
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
  const { channelFilter, accountFilter, territoryFilter, callKindFilter } =
    filterClauses(filters);
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
       ${channelFilter} ${accountFilter} ${territoryFilter} ${callKindFilter} ${scopeSql(scope)}
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
  const { dateFilter, channelFilter, accountFilter, territoryFilter, callKindFilter } =
    filterClauses(filters);
  return queryFabric<TopRep>(
    tenantId,
    `SELECT TOP 10 u.user_key, u.name, COUNT(*) AS calls
     FROM gold.fact_call f
     JOIN gold.dim_user u ON u.user_key = f.owner_user_key AND u.tenant_id = @tenantId
     WHERE f.tenant_id = @tenantId
       AND u.user_type IN ('Sales', 'Medical')
       ${dateFilter} ${channelFilter} ${accountFilter} ${territoryFilter} ${callKindFilter} ${scopeSql(scope)}
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
  const { dateFilter, channelFilter, accountFilter, territoryFilter, callKindFilter } =
    filterClauses(filters);
  return queryFabric<TopHcp>(
    tenantId,
    `SELECT TOP 10 h.hcp_key, h.name, h.specialty_primary AS specialty, COUNT(*) AS calls
     FROM gold.fact_call f
     JOIN gold.dim_hcp h ON h.hcp_key = f.hcp_key AND h.tenant_id = @tenantId
     WHERE f.tenant_id = @tenantId
       ${dateFilter} ${channelFilter} ${accountFilter} ${territoryFilter} ${callKindFilter} ${scopeSql(scope)}
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
  const { dateFilter, channelFilter, accountFilter, territoryFilter, callKindFilter } =
    filterClauses(filters);
  return queryFabric<TopHco>(
    tenantId,
    `SELECT TOP 10 h.hco_key, h.name, h.hco_type, h.city, h.state, COUNT(*) AS calls
     FROM gold.fact_call f
     JOIN gold.dim_hco h ON h.hco_key = f.hco_key AND h.tenant_id = @tenantId
     WHERE f.tenant_id = @tenantId
       ${dateFilter} ${channelFilter} ${accountFilter} ${territoryFilter} ${callKindFilter} ${scopeSql(scope)}
     GROUP BY h.hco_key, h.name, h.hco_type, h.city, h.state
     ORDER BY calls DESC`,
    mergeParams(filters, scope),
  );
}

// ---------------------------------------------------------------------------
// HCP tier coverage: per-tier rollup of "how much of the rep universe is
// being touched in the period." Universe is HCPs assigned to any
// territory the user can see (passed in as accessibleTerritoryKeys to
// avoid a second roundtrip — the caller already loaded them for the
// FilterBar). Contacted = distinct HCPs called in the period under the
// user's RLS scope. Tiers come from dim_hcp.tier; missing/blank tiers
// bucket as "Unknown" so they're visible (and actionable) rather than
// silently dropped.
//
// Returns empty when the range is "all" (no period to compute "contacted
// in window") or when the user has zero accessible territories.
// ---------------------------------------------------------------------------

export type TierCoverageRow = {
  tier: string;
  total_hcps: number;
  contacted: number;
  no_activity: number;
  pct_contacted: number;
};

export async function loadTierCoverage(
  tenantId: string,
  filters: DashboardFilters,
  accessibleTerritoryKeys: string[],
  scope: Scope = NO_SCOPE,
): Promise<TierCoverageRow[]> {
  if (accessibleTerritoryKeys.length === 0) return [];
  const dates = rangeDates(filters.range);
  if (!dates) return [];

  try {
    // Inline-IN on the territory keys (md5 hex; safe). Single-territory
    // filter takes precedence — narrows the universe to that one slice.
    const sanitizedKeys = accessibleTerritoryKeys
      .map((k) => `'${k.replace(/'/g, "''")}'`)
      .join(",");
    const territoryClause = filters.territory
      ? `AND b.territory_key = @filterTerritory`
      : `AND b.territory_key IN (${sanitizedKeys})`;

    const params = mergeParams(filters, scope);

    const rows = await queryFabric<TierCoverageRow>(
      tenantId,
      `WITH scoped_hcps AS (
         SELECT DISTINCT
           h.hcp_key,
           COALESCE(NULLIF(LTRIM(RTRIM(h.tier)), ''), 'Unknown') AS tier
         FROM gold.dim_hcp h
         JOIN gold.bridge_account_territory b
           ON b.tenant_id = h.tenant_id
           AND b.account_key = h.hcp_key
         WHERE h.tenant_id = @tenantId
           AND h.status = 'Active'
           ${territoryClause}
       ),
       contacted AS (
         SELECT DISTINCT f.hcp_key
         FROM gold.fact_call f
         WHERE f.tenant_id = @tenantId
           AND f.call_date >= @filterStart
           AND f.call_date <= @filterEnd
           AND f.hcp_key IS NOT NULL
           ${scopeSql(scope)}
       )
       SELECT
         s.tier,
         COUNT(DISTINCT s.hcp_key) AS total_hcps,
         COUNT(DISTINCT CASE WHEN c.hcp_key IS NOT NULL THEN s.hcp_key END) AS contacted,
         COUNT(DISTINCT s.hcp_key)
           - COUNT(DISTINCT CASE WHEN c.hcp_key IS NOT NULL THEN s.hcp_key END) AS no_activity,
         CASE WHEN COUNT(DISTINCT s.hcp_key) > 0
           THEN CAST(ROUND(100.0 * COUNT(DISTINCT CASE WHEN c.hcp_key IS NOT NULL THEN s.hcp_key END)
                           / COUNT(DISTINCT s.hcp_key), 0) AS INT)
           ELSE 0
         END AS pct_contacted
       FROM scoped_hcps s
       LEFT JOIN contacted c ON c.hcp_key = s.hcp_key
       GROUP BY s.tier`,
      params,
    );

    // Sort numeric tiers ascending (1, 2, 3 …), then named tiers alpha,
    // then "Unknown" last so it doesn't crowd the actionable rows.
    return rows.sort((a, b) => {
      if (a.tier === "Unknown") return 1;
      if (b.tier === "Unknown") return -1;
      const an = Number(a.tier);
      const bn = Number(b.tier);
      const aIsNum = !Number.isNaN(an);
      const bIsNum = !Number.isNaN(bn);
      if (aIsNum && bIsNum) return an - bn;
      if (aIsNum) return -1;
      if (bIsNum) return 1;
      return a.tier.localeCompare(b.tier);
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Per-(rep × tier) coverage breakdown. For each rep visible to the
// caller, computes "of the HCPs in this rep's coverage territories,
// how many did THIS REP call in the period, by tier."
//
// Universe per rep = HCPs in any territory the rep is assigned to via
// silver.user_territory (NOT just primary). Contacted per rep =
// distinct HCPs the rep themselves called in the window. So a SAM
// covering 5 territories sees a large universe; a focused-territory
// rep sees a smaller one.
//
// Returns one row per (rep_user_key, tier). Multi-tenant safe via
// tenant_id everywhere.
//
// Visibility (`viewerScope`):
//   admin / bypass — all active sales/medical reps
//   manager — only reps in their userKeys
//   rep — only themselves (returns 1 rep × N tiers, useful for self-check)
// ---------------------------------------------------------------------------

export type TierCoverageByRepRow = {
  rep_user_key: string;
  rep_name: string;
  rep_title: string | null;
  tier: string;
  total_hcps: number;
  contacted: number;
  no_activity: number;
  pct_contacted: number;
};

export async function loadTierCoverageByRep(
  tenantId: string,
  filters: DashboardFilters,
  accessibleTerritoryKeys: string[],
  viewerScope: import("@/lib/scope").UserScope,
): Promise<TierCoverageByRepRow[]> {
  if (accessibleTerritoryKeys.length === 0) return [];
  const dates = rangeDates(filters.range);
  if (!dates) return [];

  try {
    const sanitizedTerritories = accessibleTerritoryKeys
      .map((k) => `'${k.replace(/'/g, "''")}'`)
      .join(",");

    // Rep visibility filter — narrows the universe to reps the
    // viewer can see. Same role-based gating as scopeToSql but
    // applied to dim_user, not fact_call.
    let repFilter = "";
    if (viewerScope.role === "rep") {
      repFilter = `AND u.user_key = '${viewerScope.userKey.replace(/'/g, "''")}'`;
    } else if (viewerScope.role === "manager") {
      if (viewerScope.userKeys.length === 0) return [];
      const userKeyList = viewerScope.userKeys
        .map((k) => `'${k.replace(/'/g, "''")}'`)
        .join(",");
      repFilter = `AND u.user_key IN (${userKeyList})`;
    }

    const params = mergeParams(filters, NO_SCOPE);

    const rows = await queryFabric<TierCoverageByRepRow>(
      tenantId,
      `WITH rep_universe AS (
         -- For each visible rep, every HCP in any territory they're
         -- assigned to (via silver.user_territory).
         SELECT DISTINCT
           u.user_key AS rep_user_key,
           u.name AS rep_name,
           u.title AS rep_title,
           h.hcp_key,
           COALESCE(NULLIF(LTRIM(RTRIM(h.tier)), ''), 'Unknown') AS tier
         FROM gold.dim_user u
         JOIN silver.user_territory ut
           ON ut.tenant_id = u.tenant_id
           AND ut.user_id = u.veeva_user_id
           AND COALESCE(ut.status, '') IN ('', 'Active', 'active')
         JOIN gold.dim_territory t
           ON t.tenant_id = ut.tenant_id
           AND t.veeva_territory_id = ut.territory_id
         JOIN gold.bridge_account_territory b
           ON b.tenant_id = t.tenant_id
           AND b.territory_key = t.territory_key
         JOIN gold.dim_hcp h
           ON h.tenant_id = b.tenant_id
           AND h.hcp_key = b.account_key
         WHERE u.tenant_id = @tenantId
           AND u.status = 'Active'
           AND u.user_type IN ('Sales', 'Medical')
           AND h.status = 'Active'
           AND b.territory_key IN (${sanitizedTerritories})
           ${repFilter}
       ),
       contacted AS (
         -- Per-rep distinct HCPs called in window. Pairs (rep_user_key,
         -- hcp_key) so we can join to rep_universe and count "did THIS
         -- REP call THIS HCP."
         SELECT DISTINCT
           f.owner_user_key AS rep_user_key,
           f.hcp_key
         FROM gold.fact_call f
         WHERE f.tenant_id = @tenantId
           AND f.call_date >= @filterStart
           AND f.call_date <= @filterEnd
           AND f.hcp_key IS NOT NULL
       )
       SELECT
         ru.rep_user_key,
         ru.rep_name,
         ru.rep_title,
         ru.tier,
         COUNT(DISTINCT ru.hcp_key) AS total_hcps,
         COUNT(DISTINCT CASE WHEN c.hcp_key IS NOT NULL THEN ru.hcp_key END) AS contacted,
         COUNT(DISTINCT ru.hcp_key)
           - COUNT(DISTINCT CASE WHEN c.hcp_key IS NOT NULL THEN ru.hcp_key END) AS no_activity,
         CASE WHEN COUNT(DISTINCT ru.hcp_key) > 0
           THEN CAST(ROUND(100.0 * COUNT(DISTINCT CASE WHEN c.hcp_key IS NOT NULL THEN ru.hcp_key END)
                           / COUNT(DISTINCT ru.hcp_key), 0) AS INT)
           ELSE 0
         END AS pct_contacted
       FROM rep_universe ru
       LEFT JOIN contacted c
         ON c.rep_user_key = ru.rep_user_key
         AND c.hcp_key = ru.hcp_key
       GROUP BY ru.rep_user_key, ru.rep_name, ru.rep_title, ru.tier
       ORDER BY ru.rep_name, ru.tier`,
      params,
    );
    return rows;
  } catch {
    return [];
  }
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
