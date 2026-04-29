// Single horizontal-bar primitive shared by every "inline progress
// strip" in the app — score breakdown bars on the HCP page, channel-mix
// bars on PeerCohortCard, and sales mini-trend bars on
// RepRecommendationsCard.
//
// Per design review §5 + §"Visualizations addendum": one bar primitive,
// used everywhere. Track is `--color-border` (not surface-alt) so the
// strip always reads as a quantitative scale; fill is `--color-chart-1`
// (primary green) by default. Callers can override the fill colour
// when the bar carries semantic meaning (e.g. score buckets,
// negative-quarter sales bars).
//
// Width is clamped 0-100. A minimum-visible width can be passed via
// `minPct` so small-but-nonzero values stay perceptible (e.g. 2% for
// channel-mix bars where any presence should be visible).

// Hex literals here mirror the @theme tokens in globals.css. Inline
// hex avoids two failure modes we hit in practice: (a) Tailwind's
// arbitrary-value class `bg-[var(--color-chart-1)]` not always
// generating a CSS rule when the token comes from @theme, and (b) the
// browser failing to resolve `var(--color-chart-1)` from a React
// inline-style attribute even though the same token resolves fine
// from a Tailwind utility class on the same element. If the design
// tokens shift, update both places.
const DEFAULT_FILL_HEX = "#1F4E46"; // chart-1 / primary

export default function InlineBar({
  pct,
  fill,
  minPct = 0,
  height = "h-1.5",
}: {
  // 0-100. Clamped to that range internally.
  pct: number;
  // Any CSS color string. Defaults to chart-1 (primary green) hex.
  fill?: string;
  // Minimum visible width when pct > 0 — useful for distribution bars
  // where any nonzero share should be perceptible. Pass 0 to disable.
  minPct?: number;
  // Tailwind height class. Default h-1.5 (6px) per the design review's
  // single-primitive spec.
  height?: string;
}) {
  const clamped = Math.max(0, Math.min(100, pct));
  const widthPct =
    clamped > 0 && minPct > 0 ? Math.max(clamped, minPct) : clamped;
  return (
    <div
      className={`${height} rounded-full bg-[var(--color-border)] overflow-hidden`}
    >
      <div
        className="h-full rounded-full transition-all"
        style={{
          width: `${widthPct}%`,
          backgroundColor: fill ?? DEFAULT_FILL_HEX,
        }}
      />
    </div>
  );
}
