// URL-driven filter state for /dashboard. Server-safe (no React).

// Two flavors of time range:
//   Rolling: 4w / 12w / 26w / 52w  — ends at TODAY, walks back N weeks
//   Snap-to-period: mtd / qtd / ytd — start of containing period → today
//   All: no upper bound on history
// Mixing both in one selector matches how pharma users think.
export const TIME_RANGES = [
  "4w",
  "12w",
  "26w",
  "52w",
  "mtd",
  "qtd",
  "ytd",
  "all",
] as const;
export type TimeRange = (typeof TIME_RANGES)[number];

const ROLLING_RANGE_WEEKS: Record<"4w" | "12w" | "26w" | "52w", number> = {
  "4w": 4,
  "12w": 12,
  "26w": 26,
  "52w": 52,
};

export const CALL_CHANNELS = [
  "all",
  "In-person",
  "Email",
  "Phone",
  "Video",
  "Chat or Text",
  "Other",
] as const;
export type CallChannel = (typeof CALL_CHANNELS)[number];

export const ACCOUNT_TYPES = ["all", "hcp", "hco"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

// Trend chart bucket size. Controls how the line groups call_date.
//   week    — Monday-anchored, ~7 day buckets
//   month   — calendar-month buckets
//   quarter — calendar-quarter buckets
export const GRANULARITIES = ["week", "month", "quarter"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

export const GRANULARITY_LABELS: Record<Granularity, string> = {
  week: "Weekly",
  month: "Monthly",
  quarter: "Quarterly",
};

export type DashboardFilters = {
  range: TimeRange;
  channel: CallChannel;
  account: AccountType;
  granularity: Granularity;
  // Optional single-territory filter. Null = "all territories visible to
  // this user" (RLS already scopes the visible set; this further narrows).
  // V1 applies to SALES loaders only (fact_sale.territory_key is native);
  // call loaders are not territory-aware until fact_call gains an HCO/
  // territory dimension. See project_gold_fact_call_followups.
  territory: string | null;
};

export const DEFAULT_FILTERS: DashboardFilters = {
  range: "12w",
  channel: "all",
  account: "all",
  granularity: "week",
  territory: null,
};

export function parseFilters(
  raw: Record<string, string | string[] | undefined>,
): DashboardFilters {
  const range = pickEnum(raw.range, TIME_RANGES, DEFAULT_FILTERS.range);
  const channel = pickEnum(raw.channel, CALL_CHANNELS, DEFAULT_FILTERS.channel);
  const account = pickEnum(raw.account, ACCOUNT_TYPES, DEFAULT_FILTERS.account);
  const granularity = pickEnum(
    raw.granularity,
    GRANULARITIES,
    DEFAULT_FILTERS.granularity,
  );
  const territoryRaw = Array.isArray(raw.territory)
    ? raw.territory[0]
    : raw.territory;
  const territory =
    territoryRaw && territoryRaw.length > 0 ? territoryRaw : null;
  return { range, channel, account, granularity, territory };
}

// SQL fragment + params hook for territory-aware sales loaders. Returns
// empty string when no territory is selected so existing queries don't
// pay any cost on the unfiltered path.
export function territorySalesFilter(filters: DashboardFilters): string {
  return filters.territory ? `AND f.territory_key = @filterTerritory` : "";
}

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  all: "All",
  hcp: "HCP",
  hco: "HCO",
};

function pickEnum<T extends readonly string[]>(
  raw: string | string[] | undefined,
  allowed: T,
  fallback: T[number],
): T[number] {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return (allowed as readonly string[]).includes(value ?? "")
    ? (value as T[number])
    : fallback;
}

export const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  "4w": "Last 4 weeks",
  "12w": "Last 12 weeks",
  "26w": "Last 26 weeks",
  "52w": "Last 52 weeks",
  mtd: "Month to date",
  qtd: "Quarter to date",
  ytd: "Year to date",
  all: "All time",
};

// Returns SQL fragments + params to apply the current filter against gold.fact_call.
// Caller appends `${dateFilter} ${channelFilter} ${accountFilter} ${territoryFilter}`
// to its WHERE clause. dateFilter uses bound `@filterStart` / `@filterEnd`
// params — added by filtersToParams() automatically. territoryFilter binds
// `@filterTerritory` (also from filtersToParams).
export function filterClauses(filters: DashboardFilters): {
  dateFilter: string;
  channelFilter: string;
  accountFilter: string;
  territoryFilter: string;
} {
  const dates = rangeDates(filters.range);
  const dateFilter = dates
    ? `AND f.call_date >= @filterStart AND f.call_date <= @filterEnd`
    : "";
  const channelFilter =
    filters.channel === "all" ? "" : `AND f.call_channel = @channel`;
  // hcp_key + hco_key are mutually exclusive on each fact row: a call hits
  // exactly one account type, so the relevant key is non-NULL on that row.
  const accountFilter =
    filters.account === "hcp"
      ? "AND f.hcp_key IS NOT NULL"
      : filters.account === "hco"
        ? "AND f.hco_key IS NOT NULL"
        : "";
  // Calls inherit their territory through the HCP they touched. Veeva's
  // account_territory__v junction is polymorphic (HCP or HCO accounts)
  // and lands in silver.account_territory → gold.bridge_account_territory
  // — same surrogate key formula as dim_hcp.hcp_key, so we can filter
  // f.hcp_key directly against the bridge. This is current-state
  // attribution: an HCP currently assigned to the selected territory has
  // their entire call history shown. Owner-temporal SCD2 (Fennec's
  // BridgeCallTerritory pattern, pinning each call to the territory the
  // rep was in AT CALL TIME) is the eventual end-state — see
  // project_owner_temporal_scd2_followup memory.
  const territoryFilter = filters.territory
    ? `AND f.hcp_key IN (
        SELECT b.account_key
        FROM gold.bridge_account_territory b
        WHERE b.tenant_id = @tenantId
          AND b.territory_key = @filterTerritory
      )`
    : "";
  return { dateFilter, channelFilter, accountFilter, territoryFilter };
}

// Number of days the current range covers, end-inclusive. Null for "all".
export function rangeDays(range: TimeRange): number | null {
  const dates = rangeDates(range);
  if (!dates) return null;
  const ms = new Date(dates.end).getTime() - new Date(dates.start).getTime();
  return Math.round(ms / (1000 * 60 * 60 * 24)) + 1;
}

// Concrete ISO date range backing the current filter selection. Returns null
// for "all" — no meaningful start date when the user wants all of history.
// Used by SQL date filters and Postgres goal lookups alike, so both surfaces
// hit the same window.
export function rangeDates(
  range: TimeRange,
): { start: string; end: string } | null {
  if (range === "all") return null;
  const today = todayUtc();

  // Snap-to-period presets
  if (range === "mtd") {
    const start = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1),
    );
    return { start: iso(start), end: iso(today) };
  }
  if (range === "qtd") {
    const qStartMonth = Math.floor(today.getUTCMonth() / 3) * 3;
    const start = new Date(
      Date.UTC(today.getUTCFullYear(), qStartMonth, 1),
    );
    return { start: iso(start), end: iso(today) };
  }
  if (range === "ytd") {
    const start = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
    return { start: iso(start), end: iso(today) };
  }

  // Rolling
  const weeks = ROLLING_RANGE_WEEKS[range];
  const start = new Date(today);
  start.setUTCDate(start.getUTCDate() - weeks * 7);
  return { start: iso(start), end: iso(today) };
}

function todayUtc(): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function periodLabel(range: TimeRange): string {
  return range === "all" ? "all time" : TIME_RANGE_LABELS[range].toLowerCase();
}

// How many trend chart buckets to generate. Picks ceil(range_days / unit_days),
// capped at 24 so weekly granularity over "all time" doesn't render hundreds
// of buckets. For "all" range, defaults: week=24, month=24, quarter=12.
const APPROX_DAYS: Record<Granularity, number> = {
  week: 7,
  month: 30,
  quarter: 91,
};
const MAX_BUCKETS = 24;

export function chartBuckets(filters: DashboardFilters): number {
  const days = rangeDays(filters.range);
  if (days == null) {
    // "all time" — pick something sensible for the granularity
    return filters.granularity === "quarter" ? 12 : 24;
  }
  const raw = Math.ceil(days / APPROX_DAYS[filters.granularity]);
  return Math.max(1, Math.min(MAX_BUCKETS, raw));
}

export function filtersToParams(
  filters: DashboardFilters,
): Record<string, string | number | null> {
  const params: Record<string, string | number | null> = {};
  if (filters.channel !== "all") params.channel = filters.channel;
  // Bind the current range as @filterStart / @filterEnd. All loaders that
  // emit filterClauses().dateFilter must include these params.
  const dates = rangeDates(filters.range);
  if (dates) {
    params.filterStart = dates.start;
    params.filterEnd = dates.end;
  }
  if (filters.territory) {
    params.filterTerritory = filters.territory;
  }
  return params;
}
