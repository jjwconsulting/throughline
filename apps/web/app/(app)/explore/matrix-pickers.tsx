"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import {
  ROW_DIMS,
  METRICS,
  isCombinationSupported,
  type RowDim,
  type MetricId,
} from "@/lib/explore-registry";

// Combined picker for /explore: Group dim + Row dim + Metric +
// optional first-sale toggle. URL drives all four so views are
// shareable.

export default function MatrixPickers({
  rowDimId,
  groupDimId,
  metricId,
  includeFirstSale,
}: {
  rowDimId: string;
  groupDimId: string | null;
  metricId: MetricId;
  includeFirstSale: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function setParam(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v == null) params.delete(k);
      else params.set(k, v);
    }
    const qs = params.toString();
    startTransition(() => {
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    });
  }

  const firstSaleEligible = rowDimId === "hco" && metricId !== "calls";

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <Select
        label="Group by"
        value={groupDimId ?? ""}
        options={[
          { value: "", label: "(none)" },
          ...ROW_DIMS.map((d) => ({
            value: d.id,
            label: d.label,
            // Disable when same as row dim (would be redundant) or
            // doesn't support the metric.
            disabled:
              d.id === rowDimId || !isCombinationSupported(d, metricId),
            title:
              d.id === rowDimId
                ? "Same as Rows — pick a different dim to group by."
                : !isCombinationSupported(d, metricId)
                  ? unsupportedReason(d, metricId)
                  : undefined,
          })),
        ]}
        onChange={(v) => {
          setParam({ group: v === "" ? null : v });
        }}
        disabled={pending}
      />
      <Select
        label="Rows"
        value={rowDimId}
        options={ROW_DIMS.map((d) => ({
          value: d.id,
          label: d.label,
          // Disable when doesn't support the metric, or when matches
          // the current group dim (would collapse to single-dim).
          disabled:
            !isCombinationSupported(d, metricId) || d.id === groupDimId,
          title:
            d.id === groupDimId
              ? "Already chosen as Group — pick a different row dim."
              : !isCombinationSupported(d, metricId)
                ? unsupportedReason(d, metricId)
                : undefined,
        }))}
        onChange={(v) => {
          // Drop first-sale toggle if no longer eligible.
          const newEligible = v === "hco" && metricId !== "calls";
          setParam({
            row: v,
            firstSale: newEligible && includeFirstSale ? "1" : null,
          });
        }}
        disabled={pending}
      />
      <Select
        label="Metric"
        value={metricId}
        options={Object.values(METRICS).map((m) => ({
          value: m.id,
          label: m.label,
        }))}
        onChange={(v) => {
          // Switching metric may invalidate the current row dim — fall
          // back to HCO. PRESERVE current row dim explicitly when still
          // valid (not setting it would let the URL fall back to the
          // page default and silently revert the user's pick).
          const dim = ROW_DIMS.find((d) => d.id === rowDimId);
          const stillSupported = dim
            ? isCombinationSupported(dim, v as MetricId)
            : false;
          // Same logic for the group dim.
          const groupDim = groupDimId
            ? ROW_DIMS.find((d) => d.id === groupDimId)
            : null;
          const groupStillSupported = groupDim
            ? isCombinationSupported(groupDim, v as MetricId)
            : true; // null group is always "supported"
          setParam({
            metric: v,
            row: stillSupported ? rowDimId : "hco",
            group: groupStillSupported ? (groupDimId ?? null) : null,
            firstSale:
              stillSupported &&
              rowDimId === "hco" &&
              v !== "calls" &&
              includeFirstSale
                ? "1"
                : null,
          });
        }}
        disabled={pending}
      />
      {firstSaleEligible ? (
        <label className="flex items-center gap-2 text-xs text-[var(--color-ink-muted)] cursor-pointer">
          <input
            type="checkbox"
            checked={includeFirstSale}
            onChange={() =>
              setParam({ firstSale: includeFirstSale ? null : "1" })
            }
            disabled={pending}
            className="rounded border-[var(--color-border)] focus:ring-[var(--color-primary)]"
          />
          <span>First sale column</span>
        </label>
      ) : null}
      {pending ? (
        <span className="text-xs text-[var(--color-ink-muted)]">…</span>
      ) : null}
    </div>
  );
}

function unsupportedReason(dim: RowDim, metricId: MetricId): string {
  if (metricId === "calls" && !dim.supportsCalls) {
    if (dim.id === "hco_type")
      return "HCO type by calls needs hco_key on fact_call (tracked follow-up).";
    return `${dim.label} isn't supported with the Calls metric.`;
  }
  if (metricId !== "calls" && !dim.supportsSales) {
    if (dim.id === "channel")
      return "Channel only applies to call activity, not sales.";
    if (dim.id === "hcp_tier" || dim.id === "hcp_specialty")
      return "HCP-side categorical dims aren't useful for sales (867 ships to HCOs, not HCPs).";
    return `${dim.label} isn't supported with the ${METRICS[metricId].label} metric.`;
  }
  return "Unsupported combination.";
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
  options: {
    value: string;
    label: string;
    disabled?: boolean;
    title?: string;
  }[];
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
          <option
            key={o.value}
            value={o.value}
            disabled={o.disabled}
            title={o.title}
          >
            {o.label}
            {o.disabled ? " (n/a)" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
