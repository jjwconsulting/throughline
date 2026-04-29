// Top-of-page consolidated snapshot for the /reps/[user_key] page.
// Mirrors HcpSnapshotCard / HcoSnapshotCard role: one quick-read
// panel answering "how is this rep doing right now."
//
// 4 stats: Calls attainment (vs goal), Units attainment (vs effective
// goal), Coverage (HCO count + primary count), Last call (recency
// status). Server component, no LLM, no state.
//
// "Effective units goal" = sum of overlapping territory-entity goals
// for territories where this rep is the current primary rep — see
// loadRepCurrentTerritoryKeys in lib/sales.ts.

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

type EngagementStatus = {
  label: "Hot" | "Active" | "Lapsed" | "Cold";
  color: string;
  detail: string;
};

function engagementStatus(lastCallIso: string | null): EngagementStatus {
  if (!lastCallIso) {
    return {
      label: "Cold",
      color: "var(--color-ink-muted)",
      detail: "No calls on record",
    };
  }
  const last = new Date(lastCallIso + "T00:00:00Z");
  const days = Math.max(
    0,
    Math.floor((Date.now() - last.getTime()) / (1000 * 60 * 60 * 24)),
  );
  const detail =
    days === 0
      ? "Last call today"
      : days < 14
        ? `Last call ${days}d ago`
        : days < 60
          ? `Last call ${Math.round(days / 7)}w ago`
          : `Last call ${Math.round(days / 30)}mo ago`;
  if (days <= 14) return { label: "Hot", color: "var(--color-positive)", detail };
  if (days <= 60) return { label: "Active", color: "var(--color-accent)", detail };
  if (days <= 120)
    return { label: "Lapsed", color: "var(--color-negative)", detail };
  return { label: "Cold", color: "var(--color-ink-muted)", detail };
}

function attainmentColor(pct: number): string {
  if (pct >= 90) return "var(--color-positive)";
  if (pct >= 70) return "var(--color-accent)";
  return "var(--color-negative)";
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
  const status = engagementStatus(inputs.last_call_ever);

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

        {/* Engagement */}
        <Stat
          label="Engagement"
          value={
            <span style={{ color: status.color }}>{status.label}</span>
          }
          detail={status.detail}
        />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  detail,
}: {
  label: string;
  value: React.ReactNode;
  detail: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
        {label}
      </p>
      <p className="font-display text-3xl mt-2 leading-tight truncate">
        {value}
      </p>
      <p className="text-xs text-[var(--color-ink-muted)] mt-1 truncate" title={detail}>
        {detail}
      </p>
    </div>
  );
}
