// URL-driven filter state for /dashboard. Server-safe (no React).

export const TIME_RANGES = ["4w", "12w", "26w", "52w", "all"] as const;
export type TimeRange = (typeof TIME_RANGES)[number];

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

export type DashboardFilters = {
  range: TimeRange;
  channel: CallChannel;
  account: AccountType;
};

export const DEFAULT_FILTERS: DashboardFilters = {
  range: "12w",
  channel: "all",
  account: "all",
};

export function parseFilters(
  raw: Record<string, string | string[] | undefined>,
): DashboardFilters {
  const range = pickEnum(raw.range, TIME_RANGES, DEFAULT_FILTERS.range);
  const channel = pickEnum(raw.channel, CALL_CHANNELS, DEFAULT_FILTERS.channel);
  const account = pickEnum(raw.account, ACCOUNT_TYPES, DEFAULT_FILTERS.account);
  return { range, channel, account };
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
  all: "All time",
};

// Returns SQL fragments + params to apply the current filter against gold.fact_call.
// Caller appends `${dateFilter} ${channelFilter} ${accountFilter}` to its WHERE clause.
export function filterClauses(filters: DashboardFilters): {
  dateFilter: string;
  channelFilter: string;
  accountFilter: string;
} {
  const dateFilter =
    filters.range === "all"
      ? ""
      : `AND f.call_date >= DATEADD(WEEK, -${rangeWeeks(filters.range)}, CAST(GETDATE() AS date))
         AND f.call_date <= CAST(GETDATE() AS date)`;
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
  return { dateFilter, channelFilter, accountFilter };
}

export function rangeWeeks(range: Exclude<TimeRange, "all">): number {
  return { "4w": 4, "12w": 12, "26w": 26, "52w": 52 }[range];
}

// Number of weekly buckets to render in the trend chart for a given range.
// "all" falls back to 52 since weekly buckets across all time would be silly.
export function chartWeeks(range: TimeRange): number {
  return range === "all" ? 52 : rangeWeeks(range);
}

export function periodLabel(range: TimeRange): string {
  return range === "all" ? "all time" : TIME_RANGE_LABELS[range].toLowerCase();
}

export function filtersToParams(
  filters: DashboardFilters,
): Record<string, string | number | null> {
  const params: Record<string, string | number | null> = {};
  if (filters.channel !== "all") params.channel = filters.channel;
  return params;
}
