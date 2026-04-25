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

// CSV-friendly period parser. Accepts "2026-Q3" / "2026-05" / "2026" and
// returns the resolved date range. Returns null on unparseable input — let
// the caller surface that as a row error.
export function parsePeriodLabel(
  raw: string | null,
): DateRange | null {
  if (!raw) return null;
  const trimmed = raw.trim();

  // Quarter: 2026-Q3 / 2026Q3 / Q3 2026
  const qDashMatch = trimmed.match(/^(\d{4})-?Q([1-4])$/i);
  if (qDashMatch) {
    const year = Number(qDashMatch[1]);
    const q = Number(qDashMatch[2]);
    const startMonth = (q - 1) * 3;
    const start = new Date(Date.UTC(year, startMonth, 1));
    const end = new Date(Date.UTC(year, startMonth + 3, 0));
    return { start: isoDate(start), end: isoDate(end) };
  }
  const qSpaceMatch = trimmed.match(/^Q([1-4])\s+(\d{4})$/i);
  if (qSpaceMatch) {
    const year = Number(qSpaceMatch[2]);
    const q = Number(qSpaceMatch[1]);
    const startMonth = (q - 1) * 3;
    const start = new Date(Date.UTC(year, startMonth, 1));
    const end = new Date(Date.UTC(year, startMonth + 3, 0));
    return { start: isoDate(start), end: isoDate(end) };
  }

  // Month: 2026-05
  const mMatch = trimmed.match(/^(\d{4})-(\d{1,2})$/);
  if (mMatch) {
    const year = Number(mMatch[1]);
    const month = Number(mMatch[2]) - 1;
    if (month < 0 || month > 11) return null;
    const start = new Date(Date.UTC(year, month, 1));
    const end = new Date(Date.UTC(year, month + 1, 0));
    return { start: isoDate(start), end: isoDate(end) };
  }

  // Year: 2026
  const yMatch = trimmed.match(/^(\d{4})$/);
  if (yMatch) {
    const year = Number(yMatch[1]);
    return {
      start: `${year}-01-01`,
      end: `${year}-12-31`,
    };
  }

  return null;
}

// Inverse of parsePeriodLabel: render a date range as the most compact
// canonical label. Used in the CSV template so admins see the same vocab
// they'll use to edit.
export function formatPeriodForCsv(start: string, end: string): string {
  const s = new Date(start);
  const e = new Date(end);
  const sm = s.getUTCMonth();
  const em = e.getUTCMonth();
  const sy = s.getUTCFullYear();
  const ey = e.getUTCFullYear();

  if (sy === ey && sm === 0 && em === 11) return `${sy}`;
  if (sy === ey && sm % 3 === 0 && em === sm + 2) {
    const q = sm / 3 + 1;
    return `${sy}-Q${q}`;
  }
  if (sy === ey && sm === em) {
    return `${sy}-${String(sm + 1).padStart(2, "0")}`;
  }
  // Doesn't match a clean period — return a non-canonical label so the
  // upload parser rejects it cleanly. Admin should split into quarters/
  // months.
  return `${start}_to_${end}`;
}
