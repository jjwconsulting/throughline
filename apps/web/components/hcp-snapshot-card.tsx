// Top-of-page consolidated snapshot for the HCP detail page. One
// quick-read panel answering "is this HCP worth my time, and what's
// the angle?" — composite targeting score, engagement status, top
// scoring scope, parent HCO. Replaces having to scroll past KPI
// cards + trend chart to assemble the same picture.
//
// Renders for every HCP. When score/parent are missing, shows "—"
// with a sub-line explaining why instead of hiding the slot.
//
// Server component, no LLM. Engagement status is computed from
// last-call-ever recency (independent of page filter).

import Link from "next/link";
import type { HcpTargetScoreRow } from "@/lib/hcp-target-scores";
import { veevaAccountUrl } from "@/lib/veeva-url";
import CallBriefButton from "@/components/call-brief-button";

export type HcpSnapshotInputs = {
  scores: HcpTargetScoreRow[]; // raw scores; we extract composite + top scope
  last_call_ever: string | null;
  tier: string | null;
  parent_hco_key: string | null;
  parent_hco_name: string | null;
  // Veeva linkage for the "Open in Veeva" action button. Both null
  // → button hides (no Veeva config or HCP missing CRM record).
  veeva_account_id: string | null;
  vault_domain: string | null;
  // HCP key (this page's entity) — needed for Generate-call-brief
  // server action.
  hcp_key: string;
  // Viewer's user_key when viewer is a rep, else null. Drives whether
  // the call-brief button shows (briefs are rep-anchored).
  viewer_user_key: string | null;
};

const ALL_SCOPE = "__all__";

function humanizeScope(scope: string): string {
  return scope.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function humanizeAttributeName(name: string): string {
  return humanizeScope(name);
}

function scoreColor(score: number): string {
  if (score >= 70) return "var(--color-positive)";
  if (score >= 40) return "var(--color-accent)";
  return "var(--color-ink-muted)";
}

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
      ? "Called today"
      : days < 14
        ? `Called ${days}d ago`
        : days < 60
          ? `Called ${Math.round(days / 7)}w ago`
          : `Called ${Math.round(days / 30)}mo ago`;
  if (days <= 14) return { label: "Hot", color: "var(--color-positive)", detail };
  if (days <= 60) return { label: "Active", color: "var(--color-accent)", detail };
  if (days <= 120)
    return { label: "Lapsed", color: "var(--color-negative)", detail };
  return { label: "Cold", color: "var(--color-ink-muted)", detail };
}

export default function HcpSnapshotCard({
  inputs,
}: {
  inputs: HcpSnapshotInputs;
}) {
  const composite = inputs.scores.find((s) => s.scope_tag === ALL_SCOPE) ?? null;
  // Top scope = highest-scoring non-`__all__` row.
  const topScope =
    inputs.scores
      .filter((s) => s.scope_tag !== ALL_SCOPE)
      .sort((a, b) => b.score_value - a.score_value)[0] ?? null;
  const topScopeContributor = topScope?.contributors[0] ?? null;

  const status = engagementStatus(inputs.last_call_ever);
  const veevaUrl = veevaAccountUrl(inputs.vault_domain, inputs.veeva_account_id);
  const hasActions = veevaUrl || inputs.viewer_user_key;

  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-5">
      {hasActions ? (
        <div className="flex items-center justify-end gap-2 mb-3">
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
        {/* Targeting score */}
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

        {/* Engagement status */}
        <Stat
          label="Engagement"
          value={
            <span style={{ color: status.color }}>{status.label}</span>
          }
          detail={status.detail}
        />

        {/* Top scope */}
        <Stat
          label="Top scope"
          value={
            topScope ? (
              <span className="text-base md:text-xl">
                {humanizeScope(topScope.scope_tag)}
                <span
                  className="ml-2 font-mono text-sm"
                  style={{ color: scoreColor(topScope.score_value) }}
                >
                  {Math.round(topScope.score_value)}
                </span>
              </span>
            ) : (
              <span className="text-[var(--color-ink-muted)]">—</span>
            )
          }
          detail={
            topScopeContributor
              ? `${humanizeAttributeName(topScopeContributor.attribute_name)} = ${topScopeContributor.raw_value}`
              : "No therapy-area scoring"
          }
        />

        {/* Parent HCO */}
        <Stat
          label="Parent HCO"
          value={
            inputs.parent_hco_key && inputs.parent_hco_name ? (
              <Link
                href={`/hcos/${encodeURIComponent(inputs.parent_hco_key)}`}
                className="text-base md:text-xl text-[var(--color-primary)] hover:underline truncate block"
                title={inputs.parent_hco_name}
              >
                {inputs.parent_hco_name}
              </Link>
            ) : (
              <span className="text-[var(--color-ink-muted)]">—</span>
            )
          }
          detail={inputs.tier ? `Tier ${inputs.tier}` : "Tier not set"}
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
