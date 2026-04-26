"use client";

import { useMemo, useState } from "react";
import SavedMappingRow, {
  type SavedMappingRowProps,
} from "./saved-mapping-row";

// Wraps the saved mappings table with a JS-side search input (filters by
// distributor ID, target Veeva ID, or notes) so admins can find a row to
// edit without paging through 300+ entries. Server still loads up to
// `loadCap` mappings; if a tenant has more than that, the page header
// indicates truncation.
export default function SavedMappingsList({
  rows,
  totalCount,
  loadCap,
}: {
  rows: SavedMappingRowProps[];
  totalCount: number;
  loadCap: number;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      return (
        r.sourceKey.toLowerCase().includes(q) ||
        r.targetValue.toLowerCase().includes(q) ||
        (r.notes ?? "").toLowerCase().includes(q)
      );
    });
  }, [query, rows]);

  const truncated = totalCount > loadCap;

  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
      <div className="px-5 py-4 border-b border-[var(--color-border)] space-y-3">
        <div className="flex items-baseline justify-between gap-3 flex-wrap">
          <div>
            <h2 className="font-display text-xl">Saved mappings</h2>
            <p className="text-xs text-[var(--color-ink-muted)]">
              Edit or delete any existing mapping. Saves apply immediately
              to this list; sales-side resolution refreshes on the next
              data sync.
            </p>
          </div>
          <span className="text-xs text-[var(--color-ink-muted)]">
            {filtered.length === rows.length
              ? `${rows.length}`
              : `${filtered.length} of ${rows.length}`}
            {truncated ? ` (capped at ${loadCap} of ${totalCount.toLocaleString()})` : ""}
          </span>
        </div>
        {rows.length > 0 ? (
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by distributor ID, Veeva ID, or note…"
            className="w-full max-w-md px-3 py-1.5 rounded border border-[var(--color-border)] bg-white text-sm"
          />
        ) : null}
      </div>

      {rows.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-[var(--color-ink-muted)]">
          No mappings saved yet.
        </div>
      ) : filtered.length === 0 ? (
        <div className="px-5 py-8 text-center text-sm text-[var(--color-ink-muted)]">
          No mappings match &ldquo;{query}&rdquo;.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)]">
            <tr>
              <th className="text-left px-4 py-2 font-normal">
                Distributor ID
              </th>
              <th className="text-left px-4 py-2 font-normal">
                Veeva account ID
              </th>
              <th className="text-left px-4 py-2 font-normal">Notes</th>
              <th className="text-left px-4 py-2 font-normal">Updated</th>
              <th className="text-left px-4 py-2 font-normal">By</th>
              <th className="text-left px-4 py-2 font-normal w-32">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => (
              <SavedMappingRow key={r.id} row={r} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
