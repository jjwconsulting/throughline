// EngagementPill — design review Phase 1 Deliverable 4. Replaces
// inline coloured display-text used in HcpSnapshotCard,
// HcoSnapshotCard, RepSnapshotCard for engagement state.
//
// Visual: 8px saturated dot + label, on a 10%-opacity tint of the
// dot colour, with a 1px solid border at 25% opacity. 22px tall,
// sits on the same baseline as adjacent text.
//
// Semantic colour shift from previous treatment:
//   - Active: gold → primary green (resolves gold-overload)
//   - Lapsed: red → accent gold (red was too punitive — Lapsed is
//     a state to act on, not a failure)
//   - Hot:    positive green (unchanged)
//   - Cold:   ink-muted (was grey text; now grey pill for parity)
//
// The semantic shift IS the load-bearing recommendation. See
// docs/audit/design-review.md §4 for the full rationale.

export type EngagementState = "Hot" | "Active" | "Lapsed" | "Cold";

export type EngagementInput = {
  state: EngagementState;
  detail?: string; // e.g. "Last call 6 days ago" — rendered inline next to pill when provided
};

const STATE_STYLES: Record<
  EngagementState,
  { dot: string; bg: string; border: string; text: string }
> = {
  Hot: {
    dot: "bg-[var(--color-positive)]",
    bg: "bg-[var(--color-positive)]/10",
    border: "border-[var(--color-positive)]/25",
    text: "text-[var(--color-positive-deep)]",
  },
  Active: {
    dot: "bg-[var(--color-primary)]",
    bg: "bg-[var(--color-primary)]/8",
    border: "border-[var(--color-primary)]/25",
    text: "text-[var(--color-primary)]",
  },
  Lapsed: {
    dot: "bg-[var(--color-accent)]",
    bg: "bg-[var(--color-accent)]/12",
    border: "border-[var(--color-accent)]/30",
    text: "text-[var(--color-accent-deep)]",
  },
  Cold: {
    dot: "bg-[var(--color-ink-muted)]",
    bg: "bg-[var(--color-surface-alt)]",
    border: "border-[var(--color-border)]",
    text: "text-[var(--color-ink-muted)]",
  },
};

export default function EngagementPill({ state }: { state: EngagementState }) {
  const styles = STATE_STYLES[state];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium border ${styles.bg} ${styles.border}`}
    >
      <span
        className={`w-2 h-2 rounded-full ${styles.dot}`}
        aria-hidden="true"
      />
      <span className={styles.text}>{state}</span>
    </span>
  );
}

// Helper — derive engagement state from an ISO date string. Mirrors
// the existing engagementStatus() helper in HcpSnapshotCard /
// HcoSnapshotCard / RepSnapshotCard so the threshold rule lives in
// exactly one place going forward.
export function engagementStateFromLastCall(
  lastCallIso: string | null,
): { state: EngagementState; detail: string } {
  if (!lastCallIso) {
    return { state: "Cold", detail: "No calls on record" };
  }
  const last = new Date(lastCallIso + "T00:00:00Z");
  const days = Math.max(
    0,
    Math.floor((Date.now() - last.getTime()) / (1000 * 60 * 60 * 24)),
  );
  const detail =
    days === 0
      ? "Called today"
      : days < 14
        ? `Called ${days}d ago`
        : days < 60
          ? `Called ${Math.round(days / 7)}w ago`
          : `Called ${Math.round(days / 30)}mo ago`;
  if (days <= 14) return { state: "Hot", detail };
  if (days <= 60) return { state: "Active", detail };
  if (days <= 120) return { state: "Lapsed", detail };
  return { state: "Cold", detail };
}
