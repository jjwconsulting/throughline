// Score breakdown card. Per-therapy-area scoring detail + top
// contributing attributes. The headline composite + top scope live in
// HcpSnapshotCard at the top of the page; this card is the drill-down
// for "where does that composite come from."
//
// Server component — pure rendering of pre-loaded score data.
//
// Layout:
//   - Per-scope bars: one row per therapy area (cisplatin, ovarian, etc.)
//     with a horizontal bar + score value + raw top contributor
//   - Top contributors footer: the underlying attributes that drove the
//     composite, with raw values + normalized rank
//
// Empty state: card renders nothing if no scores (graceful degrade
// when no attribute mappings configured).

import type { HcpTargetScoreRow } from "@/lib/hcp-target-scores";

const ALL_SCOPE = "__all__";

function humanizeScope(scope: string): string {
  if (scope === ALL_SCOPE) return "Composite";
  // Replace underscores, title-case the words.
  return scope
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function humanizeAttributeName(name: string): string {
  return name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function scoreColor(score: number): string {
  // Three buckets — high (>= 70), mid (40-70), low (< 40). Tracks the
  // LLM prompt's score >= 80 = high-priority threshold loosely; visual
  // intent is "is this HCP worth a targeted touch?"
  if (score >= 70) return "var(--color-positive)";
  if (score >= 40) return "var(--color-accent)";
  return "var(--color-ink-muted)";
}

export default function TargetScoreCard({
  scores,
}: {
  scores: HcpTargetScoreRow[];
}) {
  if (scores.length === 0) return null;

  const composite = scores.find((s) => s.scope_tag === ALL_SCOPE);
  const perScope = scores.filter((s) => s.scope_tag !== ALL_SCOPE);

  // Headline contributors come from the composite when available;
  // otherwise from the highest-scoring per-scope row.
  const headlineContributors =
    composite?.contributors ?? perScope[0]?.contributors ?? [];

  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)]">
      <div className="px-5 py-4 border-b border-[var(--color-border)]">
        <h2 className="font-display text-lg">Score breakdown</h2>
        <p className="text-xs text-[var(--color-ink-muted)]">
          Per-therapy-area scoring + top attributes contributing to the
          composite (shown in the snapshot above).
        </p>
      </div>

      {perScope.length > 0 ? (
        <div className="px-5 py-4 space-y-2.5">
          <p className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-1">
            By therapy area
          </p>
          {perScope.map((s) => {
            const pct = Math.max(0, Math.min(100, s.score_value));
            const top = s.contributors[0];
            return (
              <div key={s.scope_tag} className="space-y-0.5">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-[var(--color-ink)]">
                    {humanizeScope(s.scope_tag)}
                  </span>
                  <span
                    className="font-mono text-xs"
                    style={{ color: scoreColor(s.score_value) }}
                  >
                    {Math.round(s.score_value)}
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-[var(--color-surface-alt)] overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: scoreColor(s.score_value),
                    }}
                  />
                </div>
                {top ? (
                  <p className="text-xs text-[var(--color-ink-muted)] mt-0.5">
                    Top contributor:{" "}
                    {humanizeAttributeName(top.attribute_name)} ={" "}
                    <span className="font-mono">{top.raw_value}</span>{" "}
                    <span>
                      ({Math.round(top.normalized)}th percentile)
                    </span>
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {headlineContributors.length > 0 ? (
        <div className="px-5 py-3 border-t border-[var(--color-border)] bg-[var(--color-surface-alt)]/30">
          <p className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-1.5">
            Top contributors to composite
          </p>
          <ul className="text-xs space-y-1">
            {headlineContributors.slice(0, 5).map((c, i) => (
              <li
                key={`${c.attribute_name}-${i}`}
                className="flex items-baseline justify-between gap-2"
              >
                <span className="text-[var(--color-ink)] truncate">
                  {humanizeAttributeName(c.attribute_name)}
                  <span className="text-[var(--color-ink-muted)]">
                    {" • "}
                    {c.source_label}
                  </span>
                </span>
                <span className="font-mono text-[var(--color-ink-muted)] flex-shrink-0">
                  <span className="text-[var(--color-ink)]">{c.raw_value}</span>
                  {" • "}
                  <span style={{ color: scoreColor(c.normalized) }}>
                    {Math.round(c.normalized)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
