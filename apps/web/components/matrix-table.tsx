"use client";

// Reusable matrix table shell for /explore. Renders one or more
// GROUPED sections — each section has an optional bold header row
// with subtotals, then indented leaf rows underneath.
//
// Single-dim mode: caller passes one section with `label = null` so
// the header row is suppressed and rows render flat.
//
// Multi-dim mode: caller passes N sections with labels — UI renders
// "Academic Medical Center · 234 / 567 / 132 / 933" then indented
// leaves "  City of Hope Duarte · 40 / 64 / 33 / 137" etc.
//
// Sort: click a column header to sort. 2-state toggle (DESC ↔ ASC).
// Sort applies to LEAVES within each group; groups stay in the
// order the loader gave (currently total DESC).
//
// Export: "Download CSV" serializes the current sorted rows, plus
// (in multi-dim mode) a "Group" column so Excel users can re-pivot
// however they want.
//
// Heatmap shading uses a single global scale (cellMin → cellMax)
// across all leaves AND group subtotals so the colors are
// comparable everywhere on screen.

import Link from "next/link";
import { useMemo, useState } from "react";

export type LeafRow = {
  key: string;
  label: string;
  href?: string | null;
  subtitle?: string | null;
  metadata: (string | null)[];
  presetCells?: (string | null)[];
  cells: (number | null)[];
  total: number;
};

export type MatrixSection = {
  // Stable key.
  key: string;
  // Display label for the group header. Null hides the header (used
  // for single-dim mode where everything's in one virtual group).
  label: string | null;
  subtitle?: string | null;
  // Optional accurate subtotals from a separate group-level query.
  // Null when not provided (single-dim mode).
  subtotalCells?: (number | null)[] | null;
  subtotalTotal?: number | null;
  leaves: LeafRow[];
};

export type MatrixTableProps = {
  sections: MatrixSection[];
  metadataHeaders: string[];
  presetHeaders?: string[];
  bucketHeaders: string[];
  cellMin: number;
  cellMax: number;
  format: "number" | "dollars";
  rowLabelHeader?: string;
  // Header for the Group column in CSV (only used when sections have
  // labels — single-dim mode skips it).
  groupHeader?: string;
  exportFilename?: string;
};

// ---------------------------------------------------------------------------
// Number formatting + heatmap shading
// ---------------------------------------------------------------------------

function formatCompactDollars(n: number): string {
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(0)}K`;
  return `${sign}$${Math.round(abs)}`;
}

function pickFormat(f: "number" | "dollars"): (n: number) => string {
  if (f === "dollars") return formatCompactDollars;
  return (n: number) => Math.round(n).toLocaleString("en-US");
}

function cellShade(
  value: number,
  cellMin: number,
  cellMax: number,
): string | undefined {
  if (value === 0) return undefined;
  if (value < 0) {
    const floor = Math.min(0, cellMin);
    const denom = Math.abs(floor);
    if (denom === 0) return undefined;
    const alpha = Math.min(0.85, Math.abs(value) / denom);
    return `rgba(178, 69, 69, ${alpha})`;
  }
  const ceiling = Math.max(0, cellMax);
  if (ceiling === 0) return undefined;
  const alpha = Math.min(0.85, value / ceiling);
  return `rgba(245, 158, 11, ${alpha})`;
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

type SortKey =
  | { kind: "label" }
  | { kind: "meta"; idx: number }
  | { kind: "preset"; idx: number }
  | { kind: "bucket"; idx: number }
  | { kind: "total" };

function sortKeyEquals(a: SortKey, b: SortKey): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "meta" && b.kind === "meta") return a.idx === b.idx;
  if (a.kind === "preset" && b.kind === "preset") return a.idx === b.idx;
  if (a.kind === "bucket" && b.kind === "bucket") return a.idx === b.idx;
  return true;
}

type SortDir = "asc" | "desc";

function valueFor(row: LeafRow, key: SortKey): string | number | null {
  if (key.kind === "label") return row.label.toLowerCase();
  if (key.kind === "total") return row.total;
  if (key.kind === "meta") {
    const v = row.metadata[key.idx];
    return v == null ? null : v.toLowerCase();
  }
  if (key.kind === "preset") {
    const v = row.presetCells?.[key.idx];
    return v == null ? null : v.toLowerCase();
  }
  return row.cells[key.idx] ?? null;
}

function sortLeaves(rows: LeafRow[], key: SortKey, dir: SortDir): LeafRow[] {
  const out = [...rows];
  out.sort((a, b) => {
    const av = valueFor(a, key);
    const bv = valueFor(b, key);
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === "number" && typeof bv === "number") {
      return dir === "asc" ? av - bv : bv - av;
    }
    const as = String(av);
    const bs = String(bv);
    return dir === "asc" ? as.localeCompare(bs) : bs.localeCompare(as);
  });
  return out;
}

function SortHeader({
  active,
  dir,
  onClick,
  children,
  align = "left",
}: {
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  children: React.ReactNode;
  align?: "left" | "right";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "inline-flex items-center gap-1 hover:text-[var(--color-ink)] " +
        (align === "right" ? "ml-auto" : "")
      }
    >
      <span>{children}</span>
      <span className="text-[10px] w-2 inline-block">
        {active ? (dir === "asc" ? "▲" : "▼") : ""}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

function escapeCsv(v: string): string {
  if (v.includes(",") || v.includes('"') || v.includes("\n")) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

function downloadCsv(args: {
  filename: string;
  rowLabelHeader: string;
  groupHeader: string | null;
  metadataHeaders: string[];
  presetHeaders: string[];
  bucketHeaders: string[];
  // Sections in display order, leaves already sorted.
  sections: MatrixSection[];
}) {
  const {
    filename,
    rowLabelHeader,
    groupHeader,
    metadataHeaders,
    presetHeaders,
    bucketHeaders,
    sections,
  } = args;
  const headers = [
    ...(groupHeader ? [groupHeader] : []),
    rowLabelHeader,
    "Subtitle",
    ...metadataHeaders,
    ...presetHeaders,
    ...bucketHeaders,
    "Total",
  ];
  const lines: string[] = [headers.map(escapeCsv).join(",")];
  for (const section of sections) {
    for (const r of section.leaves) {
      const cols: string[] = [
        ...(groupHeader ? [section.label ?? ""] : []),
        r.label,
        r.subtitle ?? "",
        ...r.metadata.map((m) => m ?? ""),
        ...(r.presetCells ?? presetHeaders.map(() => "")).map((p) => p ?? ""),
        ...r.cells.map((c) => (c == null ? "" : String(Math.round(c)))),
        String(Math.round(r.total)),
      ];
      lines.push(cols.map(escapeCsv).join(","));
    }
  }
  const csv = lines.join("\n") + "\n";
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MatrixTable({
  sections,
  metadataHeaders,
  presetHeaders = [],
  bucketHeaders,
  cellMin,
  cellMax,
  format,
  rowLabelHeader = "Account",
  groupHeader,
  exportFilename = "matrix",
}: MatrixTableProps) {
  const fmt = pickFormat(format);

  const [sortKey, setSortKey] = useState<SortKey | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const sortedSections = useMemo(() => {
    if (sortKey == null) return sections;
    return sections.map((s) => ({
      ...s,
      leaves: sortLeaves(s.leaves, sortKey, sortDir),
    }));
  }, [sections, sortKey, sortDir]);

  function clickHeader(key: SortKey) {
    if (sortKey != null && sortKeyEquals(sortKey, key)) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  }

  function isActive(key: SortKey): boolean {
    return sortKey != null && sortKeyEquals(sortKey, key);
  }

  // Total leaf count across all sections — empty state when zero.
  const totalLeafCount = sections.reduce((sum, s) => sum + s.leaves.length, 0);
  if (totalLeafCount === 0) {
    return (
      <div className="px-5 py-12 text-center text-sm text-[var(--color-ink-muted)] italic">
        No rows with activity in this window.
      </div>
    );
  }

  // Number of "filler" cells before the bucket cells in a group
  // header row — accounts for the row-label column + metadata +
  // preset columns. Used to align the subtotal cells with leaf
  // bucket cells.
  const fillerColCount = metadataHeaders.length + presetHeaders.length;

  return (
    <>
      <div className="px-5 py-2 border-b border-[var(--color-border)] flex items-center justify-end">
        <button
          type="button"
          onClick={() =>
            downloadCsv({
              filename: `${exportFilename}.csv`,
              rowLabelHeader,
              groupHeader: groupHeader ?? null,
              metadataHeaders,
              presetHeaders,
              bucketHeaders,
              sections: sortedSections,
            })
          }
          className="text-xs text-[var(--color-primary)] hover:underline"
        >
          Download CSV ↓
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead className="text-xs text-[var(--color-ink-muted)] border-b border-[var(--color-border)]">
            <tr>
              <th className="text-left font-normal px-4 py-2 sticky left-0 bg-[var(--color-surface)] z-10">
                <SortHeader
                  active={isActive({ kind: "label" })}
                  dir={sortDir}
                  onClick={() => clickHeader({ kind: "label" })}
                >
                  {rowLabelHeader}
                </SortHeader>
              </th>
              {metadataHeaders.map((h, i) => (
                <th key={h} className="text-left font-normal px-3 py-2">
                  <SortHeader
                    active={isActive({ kind: "meta", idx: i })}
                    dir={sortDir}
                    onClick={() => clickHeader({ kind: "meta", idx: i })}
                  >
                    {h}
                  </SortHeader>
                </th>
              ))}
              {presetHeaders.map((h, i) => (
                <th key={h} className="text-left font-normal px-3 py-2">
                  <SortHeader
                    active={isActive({ kind: "preset", idx: i })}
                    dir={sortDir}
                    onClick={() => clickHeader({ kind: "preset", idx: i })}
                  >
                    {h}
                  </SortHeader>
                </th>
              ))}
              {bucketHeaders.map((h, i) => (
                <th
                  key={h}
                  className="text-right font-normal px-3 py-2 whitespace-nowrap"
                >
                  <SortHeader
                    active={isActive({ kind: "bucket", idx: i })}
                    dir={sortDir}
                    onClick={() => clickHeader({ kind: "bucket", idx: i })}
                    align="right"
                  >
                    {h}
                  </SortHeader>
                </th>
              ))}
              <th className="text-right font-normal px-4 py-2 sticky right-0 bg-[var(--color-surface)] z-10 border-l border-[var(--color-border)]">
                <SortHeader
                  active={isActive({ kind: "total" })}
                  dir={sortDir}
                  onClick={() => clickHeader({ kind: "total" })}
                  align="right"
                >
                  Total
                </SortHeader>
              </th>
            </tr>
          </thead>
          <tbody>
            {sortedSections.map((section) => (
              <SectionRows
                key={section.key}
                section={section}
                showHeader={section.label != null}
                fillerColCount={fillerColCount}
                cellMin={cellMin}
                cellMax={cellMax}
                fmt={fmt}
              />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function SectionRows({
  section,
  showHeader,
  fillerColCount,
  cellMin,
  cellMax,
  fmt,
}: {
  section: MatrixSection;
  showHeader: boolean;
  fillerColCount: number;
  cellMin: number;
  cellMax: number;
  fmt: (n: number) => string;
}) {
  return (
    <>
      {showHeader ? (
        <tr className="border-t border-[var(--color-border)] bg-[var(--color-surface-alt)]/60 font-medium">
          <td className="px-4 py-2 sticky left-0 bg-[var(--color-surface-alt)]/80 z-10 backdrop-blur-sm">
            <div>{section.label}</div>
            {section.subtitle ? (
              <div className="text-xs font-normal text-[var(--color-ink-muted)]">
                {section.subtitle}
              </div>
            ) : null}
          </td>
          {/* Filler cells span metadata + preset columns. */}
          {Array.from({ length: fillerColCount }).map((_, i) => (
            <td key={i} className="px-3 py-2" />
          ))}
          {section.subtotalCells != null
            ? section.subtotalCells.map((value, i) => {
                if (value == null) {
                  return <td key={i} className="px-3 py-2" />;
                }
                const bg = cellShade(value, cellMin, cellMax);
                return (
                  <td
                    key={i}
                    className="px-3 py-2 text-right font-mono whitespace-nowrap"
                    style={bg ? { backgroundColor: bg } : undefined}
                  >
                    {fmt(value)}
                  </td>
                );
              })
            : null}
          <td className="px-4 py-2 text-right font-mono sticky right-0 bg-[var(--color-surface-alt)]/80 z-10 border-l border-[var(--color-border)] backdrop-blur-sm">
            {section.subtotalTotal != null ? fmt(section.subtotalTotal) : ""}
          </td>
        </tr>
      ) : null}
      {section.leaves.map((row) => (
        <tr
          key={row.key}
          className="border-t border-[var(--color-border)] hover:bg-[var(--color-surface-alt)]/40"
        >
          <td className="px-4 py-2 sticky left-0 bg-[var(--color-surface)] z-10">
            <div className={showHeader ? "pl-4" : ""}>
              {row.href ? (
                <Link
                  href={row.href}
                  className="text-[var(--color-primary)] hover:underline"
                >
                  {row.label}
                </Link>
              ) : (
                row.label
              )}
            </div>
            {row.subtitle ? (
              <div
                className={
                  "text-xs text-[var(--color-ink-muted)] " +
                  (showHeader ? "pl-4" : "")
                }
              >
                {row.subtitle}
              </div>
            ) : null}
          </td>
          {row.metadata.map((m, i) => (
            <td key={i} className="px-3 py-2 text-[var(--color-ink-muted)]">
              {m ?? "—"}
            </td>
          ))}
          {(row.presetCells ?? []).map((c, i) => (
            <td key={i} className="px-3 py-2 text-[var(--color-ink-muted)]">
              {c ?? "—"}
            </td>
          ))}
          {row.cells.map((value, i) => {
            if (value == null) {
              return <td key={i} className="px-3 py-2" />;
            }
            const bg = cellShade(value, cellMin, cellMax);
            return (
              <td
                key={i}
                className="px-3 py-2 text-right font-mono whitespace-nowrap"
                style={bg ? { backgroundColor: bg } : undefined}
              >
                {fmt(value)}
              </td>
            );
          })}
          <td className="px-4 py-2 text-right font-mono font-medium sticky right-0 bg-[var(--color-surface)] z-10 border-l border-[var(--color-border)]">
            {fmt(row.total)}
          </td>
        </tr>
      ))}
    </>
  );
}
