// Top-of-page consolidated snapshot for the HCO detail page. Mirrors
// HcpSnapshotCard's role: one quick-read panel answering "what
// matters about this institution and who covers it." Replaces having
// to scroll past KPI + sales sections + attribution table to
// assemble the same picture.
//
// 4 stats in a row: Engagement (Hot/Active/Lapsed/Cold based on last
// call by ANY rep), Sales motion (period vs prior + delta), Primary
// rep (linked + tier), Top affiliated HCP (linked + score). Action
// toolbar (Open in Veeva) at top-right.
//
// Server component — pure rendering of pre-loaded data, no LLM, no
// state. Engagement uses all-time last-call recency (independent of
// page filter) so it reflects the actual HCO state.

import Link from "next/link";
import { veevaAccountUrl } from "@/lib/veeva-url";

export type HcoSnapshotInputs = {
  // Engagement
  last_call_ever: string | null;
  // Sales motion (period vs prior, from loadHcoSalesKpis). Pass
  // 0/0/null when no sales activity.
  net_units_period: number;
  net_units_prior: number;
  last_sale_date: string | null;
  // Identity
  tier: string | null;
  hco_type: string | null;
  // Primary rep (from attribution chain — first entry where is_primary=1)
  primary_rep_user_key: string | null;
  primary_rep_name: string | null;
  primary_territory_label: string | null;
  // Top affiliated HCP by composite score (from loadTopScoringAffiliatedHcps)
  top_affiliated_hcp: {
    hcp_key: string;
    name: string;
    score: number;
  } | null;
  // Veeva linkage
  veeva_account_id: string | null;
  vault_domain: string | null;
};

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
      ? "Touched today"
      : days < 14
        ? `Touched ${days}d ago`
        : days < 60
          ? `Touched ${Math.round(days / 7)}w ago`
          : `Touched ${Math.round(days / 30)}mo ago`;
  if (days <= 14) return { label: "Hot", color: "var(--color-positive)", detail };
  if (days <= 60) return { label: "Active", color: "var(--color-accent)", detail };
  if (days <= 120)
    return { label: "Lapsed", color: "var(--color-negative)", detail };
  return { label: "Cold", color: "var(--color-ink-muted)", detail };
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

export default function HcoSnapshotCard({
  inputs,
}: {
  inputs: HcoSnapshotInputs;
}) {
  const status = engagementStatus(inputs.last_call_ever);
  const veevaUrl = veevaAccountUrl(inputs.vault_domain, inputs.veeva_account_id);

  // Sales motion display
  const periodUnits = Math.round(inputs.net_units_period);
  const priorUnits = Math.round(inputs.net_units_prior);
  const hasSales = periodUnits !== 0 || priorUnits !== 0 || inputs.last_sale_date;
  const deltaPct =
    priorUnits !== 0
      ? Math.round(((periodUnits - priorUnits) / Math.abs(priorUnits)) * 100)
      : null;
  const isUp = deltaPct !== null && deltaPct > 0;
  const isDown = deltaPct !== null && deltaPct < 0;
  const motionColor = isUp
    ? "var(--color-positive)"
    : isDown
      ? "var(--color-negative)"
      : "var(--color-ink)";

  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-5">
      {veevaUrl ? (
        <div className="flex items-center justify-end mb-3">
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
        </div>
      ) : null}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-5">
        {/* Engagement */}
        <Stat
          label="Engagement"
          value={
            <span style={{ color: status.color }}>{status.label}</span>
          }
          detail={status.detail}
        />

        {/* Sales motion */}
        <Stat
          label="Sales motion"
          value={
            hasSales ? (
              <span>
                {formatNumber(periodUnits)}
                {deltaPct !== null ? (
                  <span
                    className="ml-2 font-mono text-sm"
                    style={{ color: motionColor }}
                  >
                    {isUp ? "+" : ""}
                    {deltaPct}%
                  </span>
                ) : null}
              </span>
            ) : (
              <span className="text-[var(--color-ink-muted)]">—</span>
            )
          }
          detail={
            hasSales
              ? `Net units this period · ${formatNumber(priorUnits)} prior`
              : "No sales on record"
          }
        />

        {/* Primary rep */}
        <Stat
          label="Primary rep"
          value={
            inputs.primary_rep_user_key && inputs.primary_rep_name ? (
              <Link
                href={`/reps/${encodeURIComponent(inputs.primary_rep_user_key)}`}
                className="text-base md:text-xl text-[var(--color-primary)] hover:underline truncate block"
                title={inputs.primary_rep_name}
              >
                {inputs.primary_rep_name}
              </Link>
            ) : (
              <span className="text-[var(--color-ink-muted)]">No rep</span>
            )
          }
          detail={
            inputs.primary_territory_label
              ? `Via ${inputs.primary_territory_label}`
              : inputs.tier
                ? `Tier ${inputs.tier}`
                : "Tier not set"
          }
        />

        {/* Top affiliated HCP */}
        <Stat
          label="Top HCP here"
          value={
            inputs.top_affiliated_hcp ? (
              <Link
                href={`/hcps/${encodeURIComponent(inputs.top_affiliated_hcp.hcp_key)}`}
                className="text-base md:text-xl text-[var(--color-primary)] hover:underline truncate block"
                title={inputs.top_affiliated_hcp.name}
              >
                {inputs.top_affiliated_hcp.name}
                <span
                  className="ml-2 font-mono text-sm"
                  style={{ color: scoreColor(inputs.top_affiliated_hcp.score) }}
                >
                  {Math.round(inputs.top_affiliated_hcp.score)}
                </span>
              </Link>
            ) : (
              <span className="text-[var(--color-ink-muted)]">—</span>
            )
          }
          detail={
            inputs.top_affiliated_hcp
              ? "Highest composite targeting score"
              : "No affiliated HCPs scored"
          }
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
