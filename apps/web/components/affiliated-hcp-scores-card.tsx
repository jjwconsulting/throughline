// Top affiliated HCPs at an HCO ranked by composite targeting score.
// Powers the "High-targeting affiliated HCPs" section on /hcos/[hco_key].
//
// Surfaces WHY an HCO matters — answers "are there high-value
// physicians practicing here?" The list is ranked by score (PERCENT_RANK
// composite, 0-100), with last-call recency as secondary context so reps
// can spot uncalled high-value HCPs at a glance.
//
// Empty state: card renders nothing when no affiliated HCPs have scores
// (HCO with no scored physicians, or pre-Phase-2 setups).

import Link from "next/link";
import type { AffiliatedHcpScore } from "@/lib/hcp-target-scores";

function scoreColor(score: number): string {
  if (score >= 70) return "var(--color-positive)";
  if (score >= 40) return "var(--color-accent)";
  return "var(--color-ink-muted)";
}

function humanizeAttributeName(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatLastCall(dateStr: string | null): string {
  if (!dateStr) return "Never called";
  const date = new Date(dateStr);
  const diff = Math.floor(
    (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (diff < 0) return dateStr;
  if (diff === 0) return "Called today";
  if (diff < 14) return `Called ${diff}d ago`;
  if (diff < 60) return `Called ${Math.round(diff / 7)}w ago`;
  return `Called ${Math.round(diff / 30)}mo ago`;
}

export default function AffiliatedHcpScoresCard({
  hcos,
  hcoName,
}: {
  hcos: AffiliatedHcpScore[];
  hcoName: string;
}) {
  if (hcos.length === 0) return null;

  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
      <div className="px-5 py-4 border-b border-[var(--color-border)]">
        <h2 className="font-display text-lg">High-targeting HCPs here</h2>
        <p className="text-xs text-[var(--color-ink-muted)]">
          Affiliated HCPs at {hcoName} ranked by composite targeting score.
          Higher = stronger third-party signal that this HCP is worth
          targeting.
        </p>
      </div>
      <table className="w-full text-sm">
        <thead className="text-xs text-[var(--color-ink-muted)]">
          <tr>
            <th className="text-left font-normal px-5 py-2 w-12">Score</th>
            <th className="text-left font-normal px-5 py-2">HCP</th>
            <th className="text-left font-normal px-5 py-2">Specialty</th>
            <th className="text-left font-normal px-5 py-2">Tier</th>
            <th className="text-left font-normal px-5 py-2">
              Top contributors
            </th>
            <th className="text-left font-normal px-5 py-2">Last call</th>
          </tr>
        </thead>
        <tbody>
          {hcos.map((h) => (
            <tr
              key={h.hcp_key}
              className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-alt)]"
            >
              <td className="px-5 py-2">
                <span
                  className="font-mono text-sm font-medium"
                  style={{ color: scoreColor(h.score_value) }}
                >
                  {Math.round(h.score_value)}
                </span>
              </td>
              <td className="px-5 py-2">
                <Link
                  href={`/hcps/${encodeURIComponent(h.hcp_key)}`}
                  className="text-[var(--color-primary)] hover:underline"
                >
                  {h.name}
                </Link>
              </td>
              <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                {h.specialty ?? "—"}
              </td>
              <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                {h.tier ? `Tier ${h.tier}` : "—"}
              </td>
              <td className="px-5 py-2 text-xs text-[var(--color-ink-muted)]">
                {h.top_contributors.length === 0
                  ? "—"
                  : h.top_contributors
                      .map(
                        (c) =>
                          `${humanizeAttributeName(c.attribute_name)} (${c.raw_value})`,
                      )
                      .join(" · ")}
              </td>
              <td className="px-5 py-2 text-xs">
                <span
                  className={
                    h.last_call_date === null
                      ? "text-[var(--color-negative)]"
                      : "text-[var(--color-ink-muted)]"
                  }
                >
                  {formatLastCall(h.last_call_date)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
