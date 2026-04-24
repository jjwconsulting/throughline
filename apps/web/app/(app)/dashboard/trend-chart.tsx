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

type Point = { week_start: string; calls: number };

export default function TrendChart({
  data,
  goalTotal,
}: {
  data: Point[];
  // Optional: total goal value across the displayed window. The chart
  // renders a "Pace" reference line at goalTotal / data.length so each
  // weekly bar can be compared to its expected share. Pass null/undefined
  // when no goal exists for this window.
  goalTotal?: number | null;
}) {
  const formatted = data.map((d) => ({
    ...d,
    label: new Date(d.week_start).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
    }),
  }));

  const weeklyPace =
    goalTotal != null && goalTotal > 0 && data.length > 0
      ? Math.round(goalTotal / data.length)
      : null;

  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={formatted} margin={{ top: 10, right: 16, left: -8, bottom: 0 }}>
        <defs>
          <linearGradient id="callsFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--color-accent)" stopOpacity={0.35} />
            <stop offset="100%" stopColor="var(--color-accent)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--color-border)" strokeDasharray="3 3" vertical={false} />
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
          width={40}
        />
        <Tooltip
          contentStyle={{
            background: "var(--color-surface)",
            border: "1px solid var(--color-border)",
            borderRadius: 8,
            fontSize: 12,
          }}
          labelStyle={{ color: "var(--color-ink-muted)" }}
          formatter={(v) => [Number(v).toLocaleString("en-US"), "Calls"]}
        />
        <Area
          type="monotone"
          dataKey="calls"
          stroke="var(--color-accent)"
          strokeWidth={2}
          fill="url(#callsFill)"
        />
        {weeklyPace != null ? (
          <ReferenceLine
            y={weeklyPace}
            stroke="var(--color-primary)"
            strokeDasharray="4 4"
            strokeWidth={1.5}
            label={{
              value: `Pace ${weeklyPace.toLocaleString("en-US")}/wk`,
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
