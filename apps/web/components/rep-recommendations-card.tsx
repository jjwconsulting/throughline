"use client";

import Link from "next/link";
import { useState } from "react";
import type {
  RepRecommendationItem,
  RecommendationContext,
  AffiliatedHcp,
  SalesQuarter,
  RecentCall,
} from "@/lib/rep-recommendations";

// "Suggested this week" card on /reps/[user_key]. Per-row expand
// reveals contextual prep info instead of a passive read of the
// recommendation:
//   - HCO row: top affiliated HCPs at this HCO + sales mini-trend
//   - HCP row: parent HCO summary + parent's sales trend + recent calls
//
// Per `project_rep_action_paradigm` memory: deliberately NOT a
// "Mark as called" checkbox — Veeva is the source of truth for calls.
// Action buttons help reps EXECUTE the suggestion (here: prep info
// inline, no navigation needed). Future buttons can layer on top of
// this expand pattern.

const SEVERITY_BADGE: Record<
  NonNullable<RepRecommendationItem["severity"]>,
  { label: string; className: string }
> = {
  high: {
    label: "High",
    className: "bg-[var(--color-negative)]/15 text-[var(--color-negative)]",
  },
  medium: {
    label: "Medium",
    className:
      "bg-[var(--color-surface-alt)] text-[var(--color-ink)] border border-[var(--color-border)]",
  },
  low: {
    label: "Low",
    className: "bg-[var(--color-positive)]/15 text-[var(--color-positive)]",
  },
};

export default function RepRecommendationsCard({
  items,
  contextByItemKey,
  generatedAt,
  repFirstName,
}: {
  items: RepRecommendationItem[];
  // Server passes as plain object so it serializes cleanly across the
  // RSC boundary. Key format: `${kind}:${key}`.
  contextByItemKey: Record<string, RecommendationContext>;
  generatedAt: Date | string;
  repFirstName: string;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  function toggle(itemKey: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(itemKey)) next.delete(itemKey);
      else next.add(itemKey);
      return next;
    });
  }

  if (items.length === 0) return null;

  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
      <div className="px-5 py-4 border-b border-[var(--color-border)]">
        <h2 className="font-display text-lg">Suggested this week</h2>
        <p className="text-xs text-[var(--color-ink-muted)]">
          {items.length} priorit{items.length === 1 ? "y" : "ies"} for{" "}
          {repFirstName} based on recent activity, account motion, and
          watch-list status. Click a row to expand prep details.
          Generated {timeAgo(generatedAt)}.
        </p>
      </div>
      <ul>
        {items.map((item) => {
          const itemKey = `${item.kind}:${item.key}`;
          const isOpen = expanded.has(itemKey);
          const ctx = contextByItemKey[itemKey];
          const href =
            item.kind === "hco"
              ? `/hcos/${encodeURIComponent(item.key)}`
              : `/hcps/${encodeURIComponent(item.key)}`;
          const sev = item.severity ? SEVERITY_BADGE[item.severity] : null;
          return (
            <li
              key={itemKey}
              className="border-t border-[var(--color-border)]"
            >
              <div className="flex items-start gap-4 px-5 py-3 hover:bg-[var(--color-surface-alt)]/40">
                <div className="flex-shrink-0 mt-0.5">
                  {sev ? (
                    <span
                      className={`inline-flex items-center text-xs rounded px-2 py-0.5 ${sev.className}`}
                    >
                      {sev.label}
                    </span>
                  ) : (
                    <span className="inline-flex items-center text-xs rounded px-2 py-0.5 bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)]">
                      —
                    </span>
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline gap-2">
                    <Link
                      href={href}
                      className="text-sm font-medium text-[var(--color-primary)] hover:underline"
                    >
                      {item.label}
                    </Link>
                    <span className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
                      {item.kind}
                    </span>
                  </div>
                  <p className="text-sm text-[var(--color-ink-muted)] mt-1 leading-relaxed">
                    {item.reason}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => toggle(itemKey)}
                  className="flex-shrink-0 text-xs text-[var(--color-primary)] hover:underline whitespace-nowrap"
                  aria-expanded={isOpen}
                >
                  {isOpen ? "Hide" : "Show context"}
                </button>
              </div>
              {isOpen && ctx ? (
                <div className="px-5 pb-4 pt-1 bg-[var(--color-surface-alt)]/30 border-t border-[var(--color-border)]">
                  {ctx.kind === "hco" ? (
                    <HcoContext context={ctx} />
                  ) : (
                    <HcpContext context={ctx} />
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function HcoContext({
  context,
}: {
  context: Extract<RecommendationContext, { kind: "hco" }>;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-3">
      <div>
        <h4 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
          Affiliated HCPs ({context.affiliated_hcps.length})
        </h4>
        {context.affiliated_hcps.length === 0 ? (
          <p className="text-xs text-[var(--color-ink-muted)] italic">
            No HCPs at this HCO with primary affiliation set in Veeva.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {context.affiliated_hcps.map((hcp) => (
              <AffiliatedHcpRow key={hcp.hcp_key} hcp={hcp} />
            ))}
          </ul>
        )}
      </div>
      <div>
        <h4 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
          Net units (last {context.sales_trend.length} quarter
          {context.sales_trend.length === 1 ? "" : "s"})
        </h4>
        <SalesMiniTrend trend={context.sales_trend} />
      </div>
    </div>
  );
}

function HcpContext({
  context,
}: {
  context: Extract<RecommendationContext, { kind: "hcp" }>;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-3">
      <div>
        <h4 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
          Parent HCO
        </h4>
        {context.parent_hco ? (
          <div className="space-y-2">
            <Link
              href={`/hcos/${encodeURIComponent(context.parent_hco.hco_key)}`}
              className="text-sm text-[var(--color-primary)] hover:underline"
            >
              {context.parent_hco.name}
            </Link>
            {context.parent_hco.hco_type ? (
              <div className="text-xs text-[var(--color-ink-muted)]">
                {context.parent_hco.hco_type}
              </div>
            ) : null}
            {context.parent_sales_trend.length > 0 ? (
              <div className="mt-3">
                <h5 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
                  Net units at parent HCO
                </h5>
                <SalesMiniTrend trend={context.parent_sales_trend} />
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-xs text-[var(--color-ink-muted)] italic">
            No primary parent HCO set in Veeva.
          </p>
        )}
      </div>
      <div>
        <h4 className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
          Recent calls (last {context.recent_calls.length})
        </h4>
        {context.recent_calls.length === 0 ? (
          <p className="text-xs text-[var(--color-ink-muted)] italic">
            No calls to this HCP from this rep on record.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {context.recent_calls.map((call, i) => (
              <li
                key={`${call.call_date}-${i}`}
                className="text-xs flex items-center gap-2"
              >
                <span className="font-mono text-[var(--color-ink)]">
                  {call.call_date}
                </span>
                {call.channel ? (
                  <span className="text-[var(--color-ink-muted)]">
                    · {call.channel}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function AffiliatedHcpRow({ hcp }: { hcp: AffiliatedHcp }) {
  const tierBadge = tierLabel(hcp.tier);
  return (
    <li className="text-xs flex items-baseline gap-2">
      {tierBadge ? (
        <span
          className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] flex-shrink-0 ${
            tierBadge.priority === 1
              ? "bg-[var(--color-negative)]/15 text-[var(--color-negative)]"
              : tierBadge.priority === 2
                ? "bg-[var(--color-surface-alt)] text-[var(--color-ink)] border border-[var(--color-border)]"
                : "bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)]"
          }`}
        >
          {tierBadge.label}
        </span>
      ) : (
        <span className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)] flex-shrink-0">
          —
        </span>
      )}
      <Link
        href={`/hcps/${encodeURIComponent(hcp.hcp_key)}`}
        className="text-[var(--color-primary)] hover:underline truncate"
      >
        {hcp.name}
      </Link>
      {hcp.specialty ? (
        <span className="text-[var(--color-ink-muted)] truncate">
          · {hcp.specialty}
        </span>
      ) : null}
      <span
        className={
          "ml-auto text-[var(--color-ink-muted)] flex-shrink-0 " +
          (hcp.last_call_date ? "" : "italic")
        }
      >
        {hcp.last_call_date
          ? `last called ${hcp.last_call_date}`
          : "never called"}
      </span>
    </li>
  );
}

function SalesMiniTrend({ trend }: { trend: SalesQuarter[] }) {
  if (trend.length === 0) {
    return (
      <p className="text-xs text-[var(--color-ink-muted)] italic">
        No sales recorded in the trend window.
      </p>
    );
  }
  // Bar width is proportional to abs value vs max in window. Negative
  // values (returns-heavy quarter) render as a red bar.
  const maxAbs = Math.max(
    ...trend.map((q) => Math.abs(q.net_units)),
    1, // avoid div-by-zero
  );
  return (
    <ul className="space-y-1">
      {trend.map((q) => {
        const widthPct = Math.round((Math.abs(q.net_units) / maxAbs) * 100);
        const isNegative = q.net_units < 0;
        return (
          <li key={q.bucket_start} className="text-xs flex items-center gap-2">
            <span className="text-[var(--color-ink-muted)] w-12 flex-shrink-0">
              {q.bucket_label}
            </span>
            <span className="flex-1 h-2 bg-[var(--color-surface-alt)] rounded relative overflow-hidden">
              <span
                className={
                  "absolute inset-y-0 left-0 rounded " +
                  (isNegative
                    ? "bg-[var(--color-negative)]/60"
                    : "bg-[var(--color-accent)]/60")
                }
                style={{ width: `${Math.max(widthPct, 2)}%` }}
              />
            </span>
            <span className="font-mono text-[var(--color-ink)] w-16 text-right flex-shrink-0">
              {Math.round(q.net_units).toLocaleString("en-US")}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function tierLabel(
  tier: string | null,
): { label: string; priority: number } | null {
  if (!tier || tier.trim() === "") return null;
  if (tier.includes("1")) return { label: "T1", priority: 1 };
  if (tier.includes("2")) return { label: "T2", priority: 2 };
  if (tier.includes("3")) return { label: "T3", priority: 3 };
  if (tier.includes("4")) return { label: "T4", priority: 4 };
  return { label: tier.slice(0, 3), priority: 99 };
}

function timeAgo(d: Date | string): string {
  const ms = Date.now() - new Date(d).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
