"use client";

// Searchable, truncated coverage HCOs table for /reps/[user_key].
// The original always-rendered 200-row table was a wall of text that
// reps had to scroll through to find anything specific. This
// component:
//   - Shows top 20 by default (sorted is_primary DESC, name ASC)
//   - Has a search input — typing filters the WHOLE list (not just
//     the visible 20), so rows below the truncation surface when
//     they match
//   - "Show all 187" toggle to expand the unfiltered view if the
//     rep wants to scroll the entire book
//
// Filter matches against name + hco_type + city + state (any visible
// table cell text). Case-insensitive substring.
//
// Per audit 2026-04-29 and follow-up: density on rep page.

import Link from "next/link";
import { useMemo, useState } from "react";
import type { RepCoverageHco } from "@/lib/sales";

const DEFAULT_SHOWN = 20;

export default function CoverageHcosTable({
  hcos,
  repName,
}: {
  hcos: RepCoverageHco[];
  repName: string;
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);

  const repFirstName = repName.split(" ")[0] ?? repName;
  const totalCount = hcos.length;
  const primaryCount = useMemo(
    () => hcos.filter((c) => c.is_primary_for_rep === 1).length,
    [hcos],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return hcos;
    return hcos.filter((c) => {
      const haystack = [
        c.name,
        c.hco_type ?? "",
        c.city ?? "",
        c.state ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }, [hcos, query]);

  // When searching, always show all matches. When not searching,
  // truncate to DEFAULT_SHOWN unless user expanded.
  const isSearching = query.trim().length > 0;
  const visible =
    isSearching || showAll ? filtered : filtered.slice(0, DEFAULT_SHOWN);
  const truncated = !isSearching && !showAll && filtered.length > DEFAULT_SHOWN;

  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
      <div className="px-5 py-4 border-b border-[var(--color-border)] flex items-baseline justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h2 className="font-display text-lg">Coverage HCOs</h2>
          <p className="text-xs text-[var(--color-ink-muted)]">
            All HCOs assigned to {repName}&apos;s territories in Veeva
            ({totalCount} total · {primaryCount} primary).{" "}
            <span className="text-[var(--color-positive)] font-medium">Primary</span>{" "}
            = sales credit goes to {repFirstName};{" "}
            <span className="text-[var(--color-ink-muted)] italic">Co-coverage</span>{" "}
            = on the territory but credit goes to another rep.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="search"
            placeholder="Search name, type, location…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-ink)] px-3 py-1.5 w-56 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>

      {/* Result count line — context for what the user is looking at */}
      <div className="px-5 py-2 border-b border-[var(--color-border)] bg-[var(--color-surface-alt)]/30 text-xs text-[var(--color-ink-muted)] flex items-baseline justify-between gap-4">
        <span>
          {isSearching ? (
            filtered.length === 0 ? (
              <>No matches for &ldquo;{query}&rdquo;.</>
            ) : (
              <>
                {filtered.length} match{filtered.length === 1 ? "" : "es"} for
                &ldquo;{query}&rdquo;
              </>
            )
          ) : showAll ? (
            <>Showing all {totalCount}</>
          ) : truncated ? (
            <>
              Showing {DEFAULT_SHOWN} of {totalCount} (sorted Primary first)
            </>
          ) : (
            <>Showing {totalCount}</>
          )}
        </span>
        {!isSearching && truncated ? (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="text-[var(--color-primary)] hover:underline"
          >
            Show all {totalCount} →
          </button>
        ) : !isSearching && showAll && totalCount > DEFAULT_SHOWN ? (
          <button
            type="button"
            onClick={() => setShowAll(false)}
            className="text-[var(--color-primary)] hover:underline"
          >
            Show fewer
          </button>
        ) : null}
      </div>

      <table className="w-full text-sm">
        <thead className="text-xs text-[var(--color-ink-muted)]">
          <tr>
            <th className="text-left font-normal px-5 py-2 w-28">Credit</th>
            <th className="text-left font-normal px-5 py-2">HCO</th>
            <th className="text-left font-normal px-5 py-2">Type</th>
            <th className="text-left font-normal px-5 py-2">Location</th>
            <th className="text-left font-normal px-5 py-2">Via territories</th>
          </tr>
        </thead>
        <tbody>
          {visible.length === 0 ? (
            <tr>
              <td
                colSpan={5}
                className="px-5 py-8 text-center text-sm text-[var(--color-ink-muted)] italic"
              >
                {isSearching
                  ? "No HCOs match this search."
                  : "No HCOs in coverage."}
              </td>
            </tr>
          ) : (
            visible.map((c) => (
              <tr
                key={c.hco_key}
                className={
                  "border-t border-[var(--color-border)] hover:bg-[var(--color-surface-alt)] " +
                  (c.is_primary_for_rep === 1
                    ? ""
                    : "bg-[var(--color-surface-alt)]/30")
                }
              >
                <td className="px-5 py-2">
                  {c.is_primary_for_rep === 1 ? (
                    <span className="text-xs rounded px-2 py-0.5 bg-[var(--color-positive)]/15 text-[var(--color-positive)]">
                      Primary
                    </span>
                  ) : (
                    <span className="text-xs rounded px-2 py-0.5 bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)] border border-[var(--color-border)]">
                      Co-coverage
                    </span>
                  )}
                </td>
                <td className="px-5 py-2">
                  <Link
                    href={`/hcos/${encodeURIComponent(c.hco_key)}`}
                    className="text-[var(--color-primary)] hover:underline"
                  >
                    {c.name}
                  </Link>
                </td>
                <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                  {c.hco_type ?? "—"}
                </td>
                <td className="px-5 py-2 text-[var(--color-ink-muted)]">
                  {[c.city, c.state].filter(Boolean).join(", ") || "—"}
                </td>
                <td className="px-5 py-2 text-[var(--color-ink-muted)] text-xs">
                  {c.territories_covered ?? "—"}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
