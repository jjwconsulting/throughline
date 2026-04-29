"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type Point = {
  bucket_start: string;
  bucket_label: string;
  [k: string]: number | string;
};

// Formatter is selected by string flag (not function) so server components
// can pass the choice across the RSC boundary — functions aren't
// serializable.
type ValueFormat = "number" | "dollars";

function formatCompactDollars(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${Math.round(abs)}`;
}

function pickFormatter(f: ValueFormat): (n: number) => string {
  if (f === "dollars") return formatCompactDollars;
  return (n: number) => Number(n).toLocaleString("en-US");
}

export default function TrendChart({
  data,
  valueKey = "calls",
  valueLabel = "Calls",
  format = "number",
  goalTotal,
  paceUnitLabel = "wk",
}: {
  data: Point[];
  // Field on each data point to plot. Defaults to "calls" so existing
  // callers keep working without changes.
  valueKey?: string;
  // Tooltip series label.
  valueLabel?: string;
  // Selects the Y-axis + tooltip number formatter.
  format?: ValueFormat;
  // Optional: total goal value across the displayed window. The chart
  // renders a "Pace" reference line at goalTotal / data.length so each
  // bucket bar can be compared to its expected share. Pass null/undefined
  // when no goal exists for this window.
  goalTotal?: number | null;
  // Suffix for the pace label ("wk" / "mo" / "qtr"). Reflects bucket size.
  paceUnitLabel?: string;
}) {
  const fmt = pickFormatter(format);

  const formatted = data.map((d) => ({
    ...d,
    label: d.bucket_label,
  }));

  const bucketPace =
    goalTotal != null && goalTotal > 0 && data.length > 0
      ? Math.round(goalTotal / data.length)
      : null;

  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={formatted} margin={{ top: 10, right: 16, left: -8, bottom: 0 }}>
        <defs>
          {/* Default series fill = chart-1 (primary green) per design
              review §5. Accent gold is no longer the chart default —
              it's reserved for true secondary comparison series. */}
          <linearGradient id={`fill-${valueKey}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-chart-1)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--color-chart-1)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--color-chart-grid)" strokeDasharray="3 3" vertical={false} />
        <XAxis
          dataKey="label"
          stroke="var(--color-ink-muted)"
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          stroke="var(--color-ink-muted)"
          tick={{ fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          width={48}
          tickFormatter={fmt}
        />
        <Tooltip
          contentStyle={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            fontSize: 12,
          }}
          labelStyle={{ color: "var(--color-ink-muted)" }}
          formatter={(v) => [fmt(Number(v)), valueLabel]}
        />
        <Area
          type="monotone"
          dataKey={valueKey}
          stroke="var(--color-chart-1)"
          strokeWidth={2}
          fill={`url(#fill-${valueKey})`}
        />
        {bucketPace != null ? (
          <ReferenceLine
            y={bucketPace}
            stroke="var(--color-primary)"
            strokeDasharray="4 4"
            strokeWidth={1.5}
            label={{
              value: `Pace ${fmt(bucketPace)}/${paceUnitLabel}`,
              position: "insideTopRight",
              fill: "var(--color-primary)",
              fontSize: 11,
            }}
          />
        ) : null}
      </AreaChart>
    </ResponsiveContainer>
  );
}
