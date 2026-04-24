// Date math for the goals page period picker. Shared between the server-
// rendered defaults and the client-side picker that snaps dates when the
// admin switches period type.

export type PeriodType = "month" | "quarter" | "year" | "custom";

export type DateRange = { start: string; end: string };

// Returns the next full period of the given type starting after `today`.
// "Custom" returns null because there's no canonical next-custom range.
export function nextRangeForPeriodType(
  type: PeriodType,
  today: Date,
): DateRange | null {
  switch (type) {
    case "month":
      return nextMonthRange(today);
    case "quarter":
      return nextQuarterRange(today);
    case "year":
      return nextYearRange(today);
    case "custom":
      return null;
  }
}

export function nextMonthRange(today: Date): DateRange {
  const year = today.getUTCFullYear();
  const month = today.getUTCMonth();
  const start = new Date(Date.UTC(year, month + 1, 1));
  const end = new Date(Date.UTC(year, month + 2, 0));
  return { start: isoDate(start), end: isoDate(end) };
}

export function nextQuarterRange(today: Date): DateRange {
  const month = today.getUTCMonth();
  const year = today.getUTCFullYear();
  const quarterStartMonths = [0, 3, 6, 9];
  let nextStartMonth = quarterStartMonths.find((m) => m > month);
  let nextStartYear = year;
  if (nextStartMonth === undefined) {
    nextStartMonth = 0;
    nextStartYear = year + 1;
  }
  const start = new Date(Date.UTC(nextStartYear, nextStartMonth, 1));
  const end = new Date(Date.UTC(nextStartYear, nextStartMonth + 3, 0));
  return { start: isoDate(start), end: isoDate(end) };
}

export function nextYearRange(today: Date): DateRange {
  const year = today.getUTCFullYear();
  const start = new Date(Date.UTC(year + 1, 0, 1));
  const end = new Date(Date.UTC(year + 1, 11, 31));
  return { start: isoDate(start), end: isoDate(end) };
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function formatPeriodLabel(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const fmt = (d: Date) =>
    d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  return `${fmt(s)} → ${fmt(e)}`;
}
