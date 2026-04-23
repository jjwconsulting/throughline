"use client";

import { useRouter, usePathname } from "next/navigation";
import { useTransition } from "react";
import {
  CALL_CHANNELS,
  DEFAULT_FILTERS,
  TIME_RANGES,
  TIME_RANGE_LABELS,
  type CallChannel,
  type DashboardFilters,
  type TimeRange,
} from "./filters";

export default function FilterBar({ filters }: { filters: DashboardFilters }) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  function update(next: Partial<DashboardFilters>) {
    const merged = { ...filters, ...next };
    const params = new URLSearchParams();
    if (merged.range !== DEFAULT_FILTERS.range) params.set("range", merged.range);
    if (merged.channel !== DEFAULT_FILTERS.channel)
      params.set("channel", merged.channel);
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Select
        label="Range"
        value={filters.range}
        options={TIME_RANGES.map((r) => ({ value: r, label: TIME_RANGE_LABELS[r] }))}
        onChange={(v) => update({ range: v as TimeRange })}
        disabled={pending}
      />
      <Select
        label="Channel"
        value={filters.channel}
        options={CALL_CHANNELS.map((c) => ({
          value: c,
          label: c === "all" ? "All channels" : c,
        }))}
        onChange={(v) => update({ channel: v as CallChannel })}
        disabled={pending}
      />
      {pending ? (
        <span className="text-xs text-[var(--color-ink-muted)]">Updating…</span>
      ) : null}
    </div>
  );
}

function Select({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)]">
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-ink)] text-sm px-2 py-1.5 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
