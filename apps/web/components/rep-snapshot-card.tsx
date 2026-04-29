// Top-of-page consolidated snapshot for the /reps/[user_key] page.
// Mirrors HcpSnapshotCard / HcoSnapshotCard role: one quick-read
// panel answering "how is this rep doing right now."
//
// 4 stats: Calls attainment (vs goal), Units attainment (vs effective
// goal), Coverage (HCO count + primary count), Engagement (pill).
// Server component, no LLM, no state.
//
// "Effective units goal" = sum of overlapping territory-entity goals
// for territories where this rep is the current primary rep — see
// loadRepCurrentTerritoryKeys in lib/sales.ts.

import EngagementPill, {
  engagementStateFromLastCall,
} from "@/components/engagement-pill";

export type RepSnapshotInputs = {
  // Calls pace
  calls_period: number;
  calls_goal: number | null; // sum of overlapping rep-entity calls goals
  // Units pace
  net_units_period: number;
  units_goal: number | null; // sum of overlapping territory-entity goals (effective)
  // Coverage
  coverage_hco_count: number;
  primary_coverage_hco_count: number;
  // Engagement
  last_call_ever: string | null;
};

function attainmentColor(pct: number): string {
  // Per design review §5: positive text needs the *-deep variant for
  // WCAG AA at body size; mid-tier no longer uses accent gold (gold
  // overload), instead uses ink-muted to recede.
  if (pct >= 90) return "var(--color-positive-deep)";
  if (pct >= 70) return "var(--color-ink-muted)";
  return "var(--color-negative-deep)";
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatAttain(period: number, goal: number | null): {
  display: React.ReactNode;
  detail: string;
} {
  if (goal == null || goal <= 0) {
    return {
      display: <span className="text-[var(--color-ink-muted)]">—</span>,
      detail: "No goal set",
    };
  }
  const pct = Math.round((period / goal) * 100);
  return {
    display: (
      <span style={{ color: attainmentColor(pct) }}>
        {pct}%
      </span>
    ),
    detail: `${formatNumber(Math.round(period))} / ${formatNumber(Math.round(goal))}`,
  };
}

export default function RepSnapshotCard({
  inputs,
}: {
  inputs: RepSnapshotInputs;
}) {
  const calls = formatAttain(inputs.calls_period, inputs.calls_goal);
  const units = formatAttain(inputs.net_units_period, inputs.units_goal);
  const engagement = engagementStateFromLastCall(inputs.last_call_ever);

  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-5">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
        {/* Calls attainment */}
        <Stat
          label="Calls attainment"
          value={calls.display}
          detail={calls.detail}
        />

        {/* Units attainment */}
        <Stat
          label="Units attainment"
          value={units.display}
          detail={units.detail}
        />

        {/* Coverage */}
        <Stat
          label="Coverage"
          value={
            inputs.coverage_hco_count > 0 ? (
              <span>{formatNumber(inputs.coverage_hco_count)}</span>
            ) : (
              <span className="text-[var(--color-ink-muted)]">—</span>
            )
          }
          detail={
            inputs.coverage_hco_count > 0
              ? `${formatNumber(inputs.primary_coverage_hco_count)} primary HCOs · ${formatNumber(
                  inputs.coverage_hco_count - inputs.primary_coverage_hco_count,
                )} co-coverage`
              : "No HCOs in book"
          }
        />

        {/* Engagement — pill replaces previous coloured-text per design
            review §4. */}
        <Stat
          label="Engagement"
          variant="raw"
          value={<EngagementPill state={engagement.state} />}
          detail={engagement.detail}
        />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  detail,
  variant = "metric",
}: {
  label: string;
  value: React.ReactNode;
  detail: string;
  // "metric" = serif display-3xl wrapper. "raw" = no wrapper for
  // components like EngagementPill that bring their own typography.
  variant?: "metric" | "raw";
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
        {label}
      </p>
      {variant === "raw" ? (
        <div className="mt-2 leading-tight">{value}</div>
      ) : (
        <p className="font-display text-3xl mt-2 leading-tight truncate">
          {value}
        </p>
      )}
      <p className="text-xs text-[var(--color-ink-muted)] mt-1 truncate" title={detail}>
        {detail}
      </p>
    </div>
  );
}
