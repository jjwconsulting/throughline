// Descriptive peer-cohort comparison panel for the HCP detail page.
// Shows how this HCP compares to similar HCPs (same tier + specialty
// + composite-score band) on engagement frequency, channel mix, and
// the rising-prescribing subset.
//
// IMPORTANT: this panel is descriptive only. It surfaces what reps
// engaging similar HCPs are doing — it does NOT claim that any
// particular pattern causes any particular outcome. Reps' bullshit
// detectors are sharp; correlation-as-causation overclaims would
// erode trust. Footer caveat reinforces this.
//
// Renders nothing when there's no useful cohort (missing tier or
// specialty, cohort too small, no calls in window). Caller can
// pass null when the loader returns null and the card hides.

import type { PeerCohortData } from "@/lib/hcp-page-insights";

const MIN_COHORT_FOR_DISPLAY = 5;

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export default function PeerCohortCard({
  data,
}: {
  data: PeerCohortData | null;
}) {
  if (!data || data.cohort_n < MIN_COHORT_FOR_DISPLAY) return null;

  const callsDelta = data.this_hcp_calls_90d - data.cohort_median_calls_90d;
  const isUnder = callsDelta < 0;
  const isOver = callsDelta > 0;
  const risingPct =
    data.cohort_n > 0
      ? Math.round((data.rising_subset_n / data.cohort_n) * 100)
      : 0;

  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
      <div className="px-5 py-4 border-b border-[var(--color-border)]">
        <h2 className="font-display text-lg">Compared to similar HCPs</h2>
        <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">
          Cohort: <span className="text-[var(--color-ink)]">{data.cohort_definition}</span>{" "}
          ({formatNumber(data.cohort_n)} HCPs)
        </p>
      </div>

      <div className="px-5 py-4 grid grid-cols-1 md:grid-cols-3 gap-5">
        {/* Engagement comparison */}
        <div className="md:col-span-2">
          <p className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
            Engagement (last 90 days)
          </p>
          <div className="flex items-baseline gap-3">
            <span className="font-display text-3xl">
              {formatNumber(data.this_hcp_calls_90d)}
            </span>
            <span className="text-sm text-[var(--color-ink-muted)]">
              calls to this HCP · cohort median:{" "}
              <span className="font-mono text-[var(--color-ink)]">
                {formatNumber(data.cohort_median_calls_90d)}
              </span>
            </span>
          </div>
          {data.cohort_median_calls_90d > 0 ? (
            <p
              className={`text-xs mt-1.5 ${
                isUnder
                  ? "text-[var(--color-negative-deep)]"
                  : isOver
                    ? "text-[var(--color-positive-deep)]"
                    : "text-[var(--color-ink-muted)]"
              }`}
            >
              {isUnder
                ? `Under-engaged by ${Math.abs(callsDelta)} call${Math.abs(callsDelta) === 1 ? "" : "s"} vs cohort median.`
                : isOver
                  ? `Above the cohort median by ${callsDelta} call${callsDelta === 1 ? "" : "s"}.`
                  : "Engagement matches the cohort median."}
            </p>
          ) : null}

          {data.rising_subset_n >= MIN_COHORT_FOR_DISPLAY ? (
            <div className="mt-4 pt-3 border-t border-[var(--color-border)]">
              <p className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-1">
                Rising-prescribing subset
              </p>
              <p className="text-sm">
                <span className="font-mono">{formatNumber(data.rising_subset_n)}</span>{" "}
                of {formatNumber(data.cohort_n)} cohort HCPs ({risingPct}%) have
                rising net units at their parent HCO.
                {data.rising_subset_avg_calls_90d !== null ? (
                  <>
                    {" "}They average{" "}
                    <span className="font-mono">{data.rising_subset_avg_calls_90d}</span>{" "}
                    calls per HCP in the last 90 days.
                  </>
                ) : null}
              </p>
            </div>
          ) : null}
        </div>

        {/* Channel mix */}
        <div>
          <p className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
            Cohort channel mix
          </p>
          {data.cohort_channel_mix.length === 0 ? (
            <p className="text-xs text-[var(--color-ink-muted)] italic">
              No calls in the window.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {data.cohort_channel_mix.map((c) => (
                <li
                  key={c.channel}
                  className="text-xs flex items-center gap-2"
                >
                  <span className="text-[var(--color-ink)] w-24 truncate flex-shrink-0">
                    {c.channel}
                  </span>
                  <span className="flex-1 h-1.5 bg-[var(--color-surface-alt)] rounded relative overflow-hidden">
                    <span
                      className="absolute inset-y-0 left-0 rounded bg-[var(--color-accent)]/70"
                      style={{ width: `${Math.max(c.pct, 2)}%` }}
                    />
                  </span>
                  <span className="font-mono text-[var(--color-ink-muted)] w-8 text-right flex-shrink-0">
                    {c.pct}%
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="px-5 py-2.5 border-t border-[var(--color-border)] bg-[var(--color-surface-alt)]/40">
        <p className="text-[11px] text-[var(--color-ink-muted)] leading-relaxed">
          Descriptive comparison only. The rising subset is HCPs whose parent-HCO
          net units rose period-over-period — engagement patterns are correlations,
          not causal claims.
        </p>
      </div>
    </div>
  );
}
