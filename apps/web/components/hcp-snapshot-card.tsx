// Top-of-page Snapshot for the HCP detail page. Per design review
// Phase 2 §1B (item #5 in the punch list): this card now owns the
// canonical headline metrics for the page (Interactions, Reps engaged,
// Last contact, Score), with the engagement state surfaced as a pill
// in the card header. The "Recent activity" footer line collapses
// what was previously a separate SinceLastVisitCard.
//
// Cuts from the previous version:
//   - The 3-col KPI grid below the card is gone (its metrics moved
//     into the snapshot's 4-stat grid).
//   - SinceLastVisitCard is gone (its summary line collapses into
//     the snapshot footer).
//   - "Top scope" stat is gone (moved into Score breakdown expander).
//   - "Parent HCO" stat is gone (moved into the page header subtitle).
//
// Action toolbar (Open in Veeva + Generate call brief) sits at the
// bottom of the card, below the divider, alongside the recent activity
// summary — making it feel like the action area for the snapshot.
//
// Server component, no LLM. Engagement status is computed from
// last-call-ever recency (independent of page filter range).

import { veevaAccountUrl } from "@/lib/veeva-url";
import CallBriefButton from "@/components/call-brief-button";
import EngagementPill, {
  engagementStateFromLastCall,
} from "@/components/engagement-pill";
import type { HcpTargetScoreRow } from "@/lib/hcp-target-scores";
import type { SinceLastVisitData } from "@/lib/hcp-page-insights";

export type HcpSnapshotInputs = {
  // Composite scoring data (full row list — we pull the __all__
  // composite from it for the headline)
  scores: HcpTargetScoreRow[];
  // Engagement source — all-time, filter-independent
  last_call_ever: string | null;
  // 4-stat grid metrics (from loadInteractionKpis, scoped to viewer)
  interactions_period: number;
  reps_engaged: number;
  // Recent activity diff for footer line — replaces SinceLastVisitCard
  since_last_visit: SinceLastVisitData | null;
  // Veeva linkage for action toolbar (Open in Veeva button)
  veeva_account_id: string | null;
  vault_domain: string | null;
  // Brief-generation linkage (rep viewer only)
  hcp_key: string;
  viewer_user_key: string | null;
};

const ALL_SCOPE = "__all__";

function scoreColor(score: number): string {
  // Per design review §5: positive text needs *-deep variant for WCAG
  // AA. Mid-tier no longer uses accent gold (gold-overload fix); falls
  // back to ink-muted so the score stat doesn't compete with engagement
  // pill colours.
  if (score >= 70) return "var(--color-positive-deep)";
  return "var(--color-ink)";
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function lastContactLabel(lastCallIso: string | null): {
  value: string;
  detail: string;
} {
  if (!lastCallIso) return { value: "Never", detail: "No calls on record" };
  const last = new Date(lastCallIso + "T00:00:00Z");
  const days = Math.max(
    0,
    Math.floor((Date.now() - last.getTime()) / (1000 * 60 * 60 * 24)),
  );
  if (days === 0) return { value: "Today", detail: lastCallIso };
  if (days === 1) return { value: "1d ago", detail: lastCallIso };
  if (days < 14) return { value: `${days}d ago`, detail: lastCallIso };
  if (days < 60) return { value: `${Math.round(days / 7)}w ago`, detail: lastCallIso };
  return { value: `${Math.round(days / 30)}mo ago`, detail: lastCallIso };
}

// Build a compact "Recent activity" sentence from the
// SinceLastVisitData payload. Returns null when nothing material to
// surface — caller hides the footer line.
function buildRecentActivityLine(
  data: SinceLastVisitData | null,
): string | null {
  if (!data) return null;
  const bits: string[] = [];
  if (data.parent_units_delta_pct !== null && data.parent_units_delta_pct !== 0) {
    const sign = data.parent_units_delta_pct > 0 ? "+" : "";
    const pct = `${sign}${data.parent_units_delta_pct}%`;
    bits.push(`parent HCO units ${pct}`);
  }
  if (data.other_rep_calls.length > 0) {
    const callCount = data.other_rep_calls.reduce(
      (sum, r) => sum + r.calls,
      0,
    );
    const repCount = data.other_rep_calls.length;
    bits.push(
      `${callCount} call${callCount === 1 ? "" : "s"} from ${repCount} other rep${repCount === 1 ? "" : "s"}`,
    );
  }
  if (data.first_ever_parent_sale_in_window) {
    bits.push("first-ever sale at parent HCO");
  }
  if (bits.length === 0) return null;

  // Anchor framing — viewer-mode says "since your last visit," recent-
  // mode says "in last 30 days."
  const anchor =
    data.mode === "viewer"
      ? `since your last visit (${data.window_days}d ago)`
      : `in the last ${data.window_days} days`;
  return `${capitalizeFirst(bits.join(" · "))} ${anchor}.`;
}

function capitalizeFirst(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

export default function HcpSnapshotCard({
  inputs,
}: {
  inputs: HcpSnapshotInputs;
}) {
  const composite =
    inputs.scores.find((s) => s.scope_tag === ALL_SCOPE) ?? null;
  const engagement = engagementStateFromLastCall(inputs.last_call_ever);
  const veevaUrl = veevaAccountUrl(
    inputs.vault_domain,
    inputs.veeva_account_id,
  );
  const hasActions = veevaUrl || inputs.viewer_user_key;
  const recentActivity = buildRecentActivityLine(inputs.since_last_visit);
  const lastContact = lastContactLabel(inputs.last_call_ever);

  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-5">
      {/* Header row: Snapshot title + EngagementPill on the right.
          Pill is the most-loaded visual on the page per design review
          §1B — gives it a permanent home above the stat grid. */}
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className="font-display text-lg">Snapshot</h2>
        <EngagementPill state={engagement.state} />
      </div>

      {/* 4-stat grid — owns the headline metrics now that the
          standalone KPI strip is removed. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
        <Stat
          label="Interactions"
          value={formatNumber(inputs.interactions_period)}
          detail="Calls in selected period"
        />
        <Stat
          label="Reps engaged"
          value={formatNumber(inputs.reps_engaged)}
          detail="Distinct reps in period"
        />
        <Stat
          label="Last contact"
          value={lastContact.value}
          detail={engagement.detail}
        />
        <Stat
          label="Targeting score"
          value={
            composite ? (
              <span style={{ color: scoreColor(composite.score_value) }}>
                {Math.round(composite.score_value)}
              </span>
            ) : (
              <span className="text-[var(--color-ink-muted)]">—</span>
            )
          }
          detail={
            composite
              ? `of 100 · ${composite.contributor_count} signals`
              : "No scoring data for this HCP"
          }
        />
      </div>

      {/* Recent-activity footer + action toolbar. Renders nothing when
          neither side has content; renders just one side when one is
          empty. */}
      {(recentActivity || hasActions) ? (
        <div className="mt-5 pt-4 border-t border-[var(--color-border)] flex flex-col-reverse md:flex-row md:items-center justify-between gap-3">
          {recentActivity ? (
            <p className="text-sm text-[var(--color-ink-muted)] flex-1 min-w-0">
              <span className="text-[var(--color-ink)] font-medium">
                Recent activity:
              </span>{" "}
              {recentActivity}
            </p>
          ) : (
            <span className="flex-1" />
          )}
          {hasActions ? (
            <div className="flex items-center gap-2 flex-shrink-0">
              {veevaUrl ? (
                <a
                  href={veevaUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs rounded-md px-3 py-1.5 bg-[var(--color-primary)] text-white hover:opacity-90"
                >
                  Open in Veeva
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                    className="h-3 w-3"
                    aria-hidden="true"
                  >
                    <path d="M11 3a1 1 0 100 2h2.586l-6.293 6.293a1 1 0 101.414 1.414L15 6.414V9a1 1 0 102 0V4a1 1 0 00-1-1h-5z" />
                    <path d="M5 5a2 2 0 00-2 2v8a2 2 0 002 2h8a2 2 0 002-2v-3a1 1 0 10-2 0v3H5V7h3a1 1 0 000-2H5z" />
                  </svg>
                </a>
              ) : null}
              {inputs.viewer_user_key ? (
                <CallBriefButton
                  repUserKey={inputs.viewer_user_key}
                  entityKind="hcp"
                  entityKey={inputs.hcp_key}
                />
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
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
      <p
        className="text-xs text-[var(--color-ink-muted)] mt-1 truncate"
        title={detail}
      >
        {detail}
      </p>
    </div>
  );
}
