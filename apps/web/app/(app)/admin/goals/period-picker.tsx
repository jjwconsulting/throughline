"use client";

import { useState } from "react";
import {
  formatPeriodLabel,
  nextRangeForPeriodType,
  type PeriodType,
} from "./period";

type Metric = "calls" | "units" | "revenue" | "reach_pct" | "frequency";

export default function PeriodPicker({
  initialPeriodStart,
  initialPeriodEnd,
  initialPeriodType,
  initialMetric,
}: {
  initialPeriodStart: string;
  initialPeriodEnd: string;
  initialPeriodType: PeriodType;
  initialMetric: Metric;
}) {
  const [periodType, setPeriodType] = useState<PeriodType>(initialPeriodType);
  const [periodStart, setPeriodStart] = useState(initialPeriodStart);
  const [periodEnd, setPeriodEnd] = useState(initialPeriodEnd);

  function handlePeriodTypeChange(next: PeriodType) {
    setPeriodType(next);
    if (next === "custom") return; // leave dates alone
    const range = nextRangeForPeriodType(next, new Date());
    if (range) {
      setPeriodStart(range.start);
      setPeriodEnd(range.end);
    }
  }

  return (
    <form
      method="GET"
      className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-4 flex items-end gap-4 flex-wrap"
    >
      <div>
        <label className="block text-xs text-[var(--color-ink-muted)] mb-1">
          Metric
        </label>
        <select
          name="metric"
          defaultValue={initialMetric}
          className="px-2 py-1.5 rounded border border-[var(--color-border)] bg-white text-sm"
        >
          <option value="calls">Calls</option>
          <option value="units" disabled>
            Units (needs sales fact)
          </option>
          <option value="revenue" disabled>
            Revenue (needs sales fact)
          </option>
        </select>
      </div>
      <div>
        <label className="block text-xs text-[var(--color-ink-muted)] mb-1">
          Period type
        </label>
        <select
          name="period_type"
          value={periodType}
          onChange={(e) => handlePeriodTypeChange(e.target.value as PeriodType)}
          className="px-2 py-1.5 rounded border border-[var(--color-border)] bg-white text-sm"
        >
          <option value="month">Month</option>
          <option value="quarter">Quarter</option>
          <option value="year">Year</option>
          <option value="custom">Custom</option>
        </select>
      </div>
      <div>
        <label className="block text-xs text-[var(--color-ink-muted)] mb-1">
          Period start
        </label>
        <input
          type="date"
          name="period_start"
          value={periodStart}
          onChange={(e) => setPeriodStart(e.target.value)}
          className="px-2 py-1.5 rounded border border-[var(--color-border)] bg-white text-sm"
        />
      </div>
      <div>
        <label className="block text-xs text-[var(--color-ink-muted)] mb-1">
          Period end
        </label>
        <input
          type="date"
          name="period_end"
          value={periodEnd}
          onChange={(e) => setPeriodEnd(e.target.value)}
          className="px-2 py-1.5 rounded border border-[var(--color-border)] bg-white text-sm"
        />
      </div>
      <button
        type="submit"
        className="px-3 py-1.5 rounded border border-[var(--color-border)] text-sm hover:bg-[var(--color-surface-alt)]"
      >
        Reload
      </button>
      <p className="ml-auto text-xs text-[var(--color-ink-muted)]">
        Recommending for:{" "}
        <span className="font-medium">
          {formatPeriodLabel(periodStart, periodEnd)}
        </span>
      </p>
    </form>
  );
}
