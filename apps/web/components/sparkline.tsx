// Inline SVG sparkline. Used inside KPI cards on /dashboard to show
// the 12ish-week trajectory of the metric below its headline number,
// per design review §"Visualizations addendum" item 1 (KPI card
// sparklines — biggest perceived-density win for the smallest amount
// of new chart code).
//
// Spec from design-review.md §"Shared design vocabulary for charts":
// 24px tall, no axis, no labels, single fill colour. We render via
// raw SVG (not Recharts) because:
//   - Recharts ResponsiveContainer adds a wrapper that's too tall
//     for in-card sparklines (24-32px target).
//   - At this size axis/grid components are noise; we don't need any.
//   - SVG path is ~30 lines and ships zero new bundle weight.
//
// Renders nothing for empty data or a single point (no line to draw).
// All-zero data renders a flat line at the bottom — visually correct
// signal of "nothing happened in window" rather than blank space.
//
// Supports negative values (sales returns) by drawing a baseline at
// y=0 in viewBox coordinates and letting the path dip below.

export type SparklinePoint = {
  // The y-value to plot. Anything that resolves to a number works;
  // strings get coerced via Number().
  value: number;
};

export default function Sparkline({
  data,
  fill = "var(--color-chart-1)",
  height = 24,
  ariaLabel,
}: {
  data: SparklinePoint[];
  // CSS color string. Defaults to chart-1 (primary green).
  fill?: string;
  // Pixel height. Width is always 100% of container.
  height?: number;
  // Optional accessibility label (e.g. "Calls trend, 13 weeks").
  ariaLabel?: string;
}) {
  if (data.length < 2) return null;

  // Use viewBox 0 0 100 H for a pure ratio-based path. Width responds
  // to container; we'll plot x as percentage across.
  const W = 100;
  const H = 100;
  const values = data.map((d) => Number(d.value) || 0);
  const min = Math.min(...values, 0);
  const max = Math.max(...values, 0);
  const range = max - min || 1;
  const yOf = (v: number) => H - ((v - min) / range) * H;
  const xOf = (i: number) => (i / (values.length - 1)) * W;

  const points = values.map((v, i) => `${xOf(i)},${yOf(v)}`);
  const linePath = `M ${points.join(" L ")}`;
  // Closed area for the gradient fill: line down to baseline → back to
  // start. Baseline = y=0 in data space (so negative values produce
  // bars below the baseline, matching the line). Falls back to bottom
  // edge when all data is positive.
  const baselineY = yOf(0);
  const areaPath = `${linePath} L ${xOf(values.length - 1)},${baselineY} L ${xOf(0)},${baselineY} Z`;

  // Unique gradient id so multiple sparklines on the same page don't
  // collide. Math.random isn't deterministic but server + client
  // render the same DOM tree, and the id is local to this SVG —
  // collisions across instances don't affect rendering.
  const gradientId = `sparkline-fill-${Math.random().toString(36).slice(2, 9)}`;

  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      width="100%"
      height={height}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="block"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={fill} stopOpacity={0.35} />
          <stop offset="100%" stopColor={fill} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
      <path
        d={linePath}
        fill="none"
        stroke={fill}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
