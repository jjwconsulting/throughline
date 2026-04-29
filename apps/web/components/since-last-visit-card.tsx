// Deterministic activity-context panel for the HCP detail page. Two
// rendering modes driven by the loader:
//   - mode='viewer': "Since your last visit (X weeks ago)" — anchored
//     on the rep viewer's most-recent call to this HCP.
//   - mode='recent': "Recent activity (last 30 days)" — fallback for
//     admin/manager viewers and reps who've never called this HCP.
//     Always meaningful regardless of HCP touch history.
//
// Both modes surface the same data shape (parent-HCO sales motion,
// other reps' calls, first-ever-sale flag) but with different
// framing copy. Renders nothing only when there's truly nothing to
// say (no anchor, no parent sales motion, no first-ever-sale signal).
//
// Powered by loadSinceLastVisit in lib/hcp-page-insights.ts.

import Link from "next/link";
import type { SinceLastVisitData } from "@/lib/hcp-page-insights";

function timeAgoLabel(daysAgo: number | null): string {
  if (daysAgo === null) return "";
  if (daysAgo === 0) return "today";
  if (daysAgo === 1) return "1 day ago";
  if (daysAgo < 14) return `${daysAgo} days ago`;
  if (daysAgo < 60) return `${Math.round(daysAgo / 7)} weeks ago`;
  if (daysAgo < 365) return `${Math.round(daysAgo / 30)} months ago`;
  return `${Math.round(daysAgo / 365)} years ago`;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

function formatDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function SinceLastVisitCard({
  data,
}: {
  data: SinceLastVisitData | null;
}) {
  if (!data) return null;

  const {
    mode,
    window_days,
    most_recent_call_date,
    most_recent_call_rep_name,
    most_recent_call_days_ago,
  } = data;

  // Header copy varies by mode.
  let headerTitle: string;
  let headerSub: string;
  if (mode === "viewer") {
    headerTitle = "Since your last visit";
    headerSub = `Your most recent call: ${timeAgoLabel(window_days)}`;
  } else {
    headerTitle = "Recent activity";
    if (most_recent_call_date) {
      headerSub = `Last ${window_days} days · most recent call by ${most_recent_call_rep_name ?? "another rep"}, ${timeAgoLabel(most_recent_call_days_ago)}`;
    } else {
      headerSub = `Last ${window_days} days · no prior calls on record for this HCP`;
    }
  }

  const hasParentSales =
    data.parent_units_since !== null &&
    data.parent_units_prior_window !== null &&
    data.parent_hco_name &&
    (data.parent_units_since !== 0 || data.parent_units_prior_window !== 0);
  const hasOtherReps = data.other_rep_calls.length > 0;
  const hasFirstEver = data.first_ever_parent_sale_in_window !== null;

  // Empty state copy varies by mode + recency.
  if (!hasParentSales && !hasOtherReps && !hasFirstEver) {
    let emptyMsg: string;
    if (mode === "viewer" && window_days < 7) {
      // Rep called very recently — empty is the correct answer.
      emptyMsg =
        "You called recently — no new activity to surface yet. Check back after a few days.";
    } else if (mode === "viewer") {
      emptyMsg =
        "No new activity since your last visit — no calls by other reps, no sales motion at the parent HCO.";
    } else {
      emptyMsg = `No notable activity in the last ${window_days} days — no calls by any rep, no sales motion at the parent HCO.`;
    }
    return (
      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-5">
        <h2 className="font-display text-lg">{headerTitle}</h2>
        {headerSub ? (
          <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">{headerSub}</p>
        ) : null}
        <p className="mt-3 text-sm text-[var(--color-ink-muted)] italic">
          {emptyMsg}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
      <div className="px-5 py-4 border-b border-[var(--color-border)]">
        <h2 className="font-display text-lg">{headerTitle}</h2>
        {headerSub ? (
          <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">{headerSub}</p>
        ) : null}
      </div>

      <ul className="divide-y divide-[var(--color-border)]">
        {hasParentSales ? (
          <li className="px-5 py-3.5">
            <ParentSalesRow data={data} />
          </li>
        ) : null}
        {hasFirstEver ? (
          <li className="px-5 py-3.5">
            <FirstSaleRow date={data.first_ever_parent_sale_in_window!} />
          </li>
        ) : null}
        {hasOtherReps ? (
          <li className="px-5 py-3.5">
            <OtherRepsRow mode={mode} calls={data.other_rep_calls} />
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function ParentSalesRow({ data }: { data: SinceLastVisitData }) {
  const since = data.parent_units_since ?? 0;
  const prior = data.parent_units_prior_window ?? 0;
  const delta = data.parent_units_delta_pct;
  const isUp = delta !== null && delta > 0;
  const isDown = delta !== null && delta < 0;

  return (
    <div className="flex items-baseline justify-between gap-4">
      <div className="flex-1 min-w-0">
        <p className="text-sm">
          <span className="font-medium">Net units at {data.parent_hco_name}</span>
          <span className="text-[var(--color-ink-muted)]">
            {" "}
            (parent HCO):{" "}
          </span>
          <span className="font-mono">{formatNumber(since)}</span>
          <span className="text-[var(--color-ink-muted)]">
            {" "}
            in window · {formatNumber(prior)} in equivalent prior window
          </span>
        </p>
      </div>
      {delta !== null ? (
        <span
          className={`font-mono text-sm flex-shrink-0 ${
            isUp
              ? "text-[var(--color-positive-deep)]"
              : isDown
                ? "text-[var(--color-negative-deep)]"
                : "text-[var(--color-ink-muted)]"
          }`}
        >
          {isUp ? "+" : ""}
          {delta}%
        </span>
      ) : null}
    </div>
  );
}

function FirstSaleRow({ date }: { date: string }) {
  return (
    <div>
      <p className="text-sm">
        <span className="text-[var(--color-positive-deep)] font-medium">
          First-ever sale at parent HCO
        </span>
        <span className="text-[var(--color-ink-muted)]">
          {" "}
          recorded {formatDate(date)} — new account.
        </span>
      </p>
    </div>
  );
}

function OtherRepsRow({
  mode,
  calls,
}: {
  mode: "viewer" | "recent";
  calls: SinceLastVisitData["other_rep_calls"];
}) {
  return (
    <div>
      <p className="text-sm font-medium mb-1">
        {mode === "viewer"
          ? "Other reps who've called this HCP since"
          : "Reps who called this HCP in the window"}
      </p>
      <ul className="space-y-1">
        {calls.map((c) => (
          <li
            key={c.user_key}
            className="text-xs flex items-baseline gap-2"
          >
            <Link
              href={`/reps/${encodeURIComponent(c.user_key)}`}
              className="text-[var(--color-primary)] hover:underline"
            >
              {c.name}
            </Link>
            <span className="text-[var(--color-ink-muted)]">
              {c.calls} call{c.calls === 1 ? "" : "s"} · last on{" "}
              {formatDate(c.last_call)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
