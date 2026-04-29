"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import {
  CALL_CHANNELS,
  CALL_KINDS,
  CALL_KIND_LABELS,
  DEFAULT_FILTERS,
  GRANULARITIES,
  GRANULARITY_LABELS,
  TIME_RANGES,
  TIME_RANGE_LABELS,
  type CallChannel,
  type CallKind,
  type DashboardFilters,
  type Granularity,
  type TimeRange,
} from "./filters";

export type FilterBarTerritory = {
  territory_key: string;
  label: string;
  code: string;
};

export default function FilterBar({
  filters,
  territories = [],
}: {
  filters: DashboardFilters;
  // Server-loaded list of territories the current user can pick from.
  // Empty array hides the dropdown; one or more shows "All" + each.
  territories?: FilterBarTerritory[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function update(next: Partial<DashboardFilters>) {
    const merged = { ...filters, ...next };
    // Start from existing params so we preserve URL state owned by
    // OTHER components on the page (e.g. /explore's row + metric
    // pickers). Only set/delete the filter keys this bar manages —
    // delete on default to keep URLs clean when nothing's selected.
    const params = new URLSearchParams(searchParams.toString());
    if (merged.range === DEFAULT_FILTERS.range) params.delete("range");
    else params.set("range", merged.range);
    if (merged.channel === DEFAULT_FILTERS.channel) params.delete("channel");
    else params.set("channel", merged.channel);
    if (merged.granularity === DEFAULT_FILTERS.granularity)
      params.delete("granularity");
    else params.set("granularity", merged.granularity);
    if (merged.territory) params.set("territory", merged.territory);
    else params.delete("territory");
    if (merged.callKind === DEFAULT_FILTERS.callKind) params.delete("callKind");
    else params.set("callKind", merged.callKind);
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Select
        label="Range"
        value={filters.range}
        options={TIME_RANGES.map((r) => ({ value: r, label: TIME_RANGE_LABELS[r] }))}
        onChange={(v) => update({ range: v as TimeRange })}
        disabled={pending}
      />
      <Select
        label="Granularity"
        value={filters.granularity}
        options={GRANULARITIES.map((g) => ({
          value: g,
          label: GRANULARITY_LABELS[g],
        }))}
        onChange={(v) => update({ granularity: v as Granularity })}
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
      <Select
        label="Type"
        value={filters.callKind}
        options={CALL_KINDS.map((k) => ({
          value: k,
          label: CALL_KIND_LABELS[k],
        }))}
        onChange={(v) => update({ callKind: v as CallKind })}
        disabled={pending}
      />
      {territories.length > 0 ? (
        <Select
          label="Territory"
          value={filters.territory ?? ""}
          options={[
            { value: "", label: "All territories" },
            ...territories.map((t) => ({
              value: t.territory_key,
              label: t.label,
            })),
          ]}
          onChange={(v) => update({ territory: v === "" ? null : v })}
          disabled={pending}
        />
      ) : null}
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
