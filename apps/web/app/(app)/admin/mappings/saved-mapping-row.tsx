"use client";

import { useActionState, useState, useTransition } from "react";
import {
  saveAccountMappingAction,
  searchVeevaAccountsAction,
  deleteMappingAction,
  type SaveMappingState,
  type VeevaAccountMatch,
} from "./actions";

const initialSave: SaveMappingState = { error: null, success: null };
const initialDelete: { error: string | null } = { error: null };

export type SavedMappingRowProps = {
  id: string;
  sourceKey: string;
  targetValue: string;
  notes: string | null;
  updatedBy: string;
  updatedAt: Date;
};

// Compact row for /admin/mappings "Saved mappings" panel. Read-only by
// default; expands into a search-and-pick edit panel when admin clicks
// "Edit", or a confirm-and-delete prompt for "Delete". Edit reuses the
// same saveAccountMappingAction as initial mapping (upsert handles both
// insert + update via the (tenant, kind, source_key) key).
export default function SavedMappingRow({ row }: { row: SavedMappingRowProps }) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VeevaAccountMatch[]>([]);
  const [searchPending, startSearch] = useTransition();
  const [picked, setPicked] = useState<VeevaAccountMatch | null>(null);

  const [saveState, saveAction, savePending] = useActionState(
    saveAccountMappingAction,
    initialSave,
  );
  const [deleteState, deleteAction, deletePending] = useActionState(
    deleteMappingAction,
    initialDelete,
  );

  function runSearch(q: string) {
    setQuery(q);
    startSearch(async () => {
      const matches = await searchVeevaAccountsAction(q, "ALL");
      setResults(matches);
    });
  }

  // Once a save completes successfully, the page revalidates and refetches —
  // but we keep the success message visible until refresh so the admin sees
  // confirmation. Same pattern as AccountMappingRow.
  const justSaved = saveState.success != null;

  return (
    <>
      <tr
        className={
          "border-t border-[var(--color-border)] align-top hover:bg-[var(--color-surface-alt)] " +
          (justSaved ? "bg-[var(--color-positive)]/5" : "")
        }
      >
        <td className="px-4 py-2 font-mono text-xs">{row.sourceKey}</td>
        <td className="px-4 py-2 font-mono text-xs">{row.targetValue}</td>
        <td className="px-4 py-2 text-[var(--color-ink-muted)]">
          {row.notes ?? "—"}
        </td>
        <td className="px-4 py-2 text-[var(--color-ink-muted)] text-xs whitespace-nowrap">
          {row.updatedAt.toISOString().slice(0, 10)}
        </td>
        <td className="px-4 py-2 text-[var(--color-ink-muted)] text-xs">
          {row.updatedBy}
        </td>
        <td className="px-4 py-2">
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => {
                setEditing((e) => !e);
                setConfirmDelete(false);
              }}
              disabled={savePending || deletePending}
              className="text-xs rounded border border-[var(--color-border)] px-2 py-0.5 hover:bg-[var(--color-surface)] disabled:opacity-50"
            >
              {editing ? "Cancel" : "Edit"}
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmDelete((d) => !d);
                setEditing(false);
              }}
              disabled={savePending || deletePending}
              className="text-xs rounded border border-[var(--color-border)] px-2 py-0.5 hover:bg-[var(--color-negative)]/10 hover:border-[var(--color-negative)] hover:text-[var(--color-negative-deep)] disabled:opacity-50"
            >
              {confirmDelete ? "Cancel" : "Delete"}
            </button>
          </div>
        </td>
      </tr>

      {confirmDelete ? (
        <tr className="border-t border-[var(--color-border)] bg-[var(--color-negative)]/5">
          <td colSpan={6} className="px-4 py-3 text-xs">
            <form
              action={deleteAction}
              className="flex items-center gap-3 flex-wrap"
            >
              <input type="hidden" name="id" value={row.id} />
              <span>
                Delete mapping for{" "}
                <span className="font-mono">{row.sourceKey}</span>? Sales
                rows for this distributor will revert to unmapped on the
                next pipeline refresh.
              </span>
              <button
                type="submit"
                disabled={deletePending}
                className="px-3 py-1 rounded bg-[var(--color-negative)] text-white text-xs hover:opacity-90 disabled:opacity-50"
              >
                {deletePending ? "Deleting…" : "Confirm delete"}
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
              >
                Cancel
              </button>
              {deleteState.error ? (
                <span className="text-[var(--color-negative-deep)]">
                  {deleteState.error}
                </span>
              ) : null}
            </form>
          </td>
        </tr>
      ) : null}

      {editing ? (
        <tr className="border-t border-[var(--color-border)] bg-[var(--color-surface-alt)]">
          <td colSpan={6} className="px-4 py-4">
            <div className="space-y-3">
              <div className="text-xs text-[var(--color-ink-muted)]">
                Currently mapped to{" "}
                <span className="font-mono text-[var(--color-ink)]">
                  {row.targetValue}
                </span>
                . Search and pick a new Veeva account to re-map. Saving
                overwrites the existing mapping.
              </div>

              <div>
                <label className="text-xs text-[var(--color-ink-muted)]">
                  Search Veeva accounts (HCP + HCO)
                </label>
                <input
                  type="text"
                  value={query}
                  onChange={(e) => runSearch(e.target.value)}
                  placeholder="Type a name…"
                  className="w-full max-w-md px-3 py-1.5 rounded border border-[var(--color-border)] bg-white text-sm mt-1"
                  autoFocus
                />
              </div>

              {searchPending ? (
                <p className="text-xs text-[var(--color-ink-muted)]">
                  Searching…
                </p>
              ) : null}

              {!searchPending && results.length === 0 && query.length >= 2 ? (
                <p className="text-xs text-[var(--color-ink-muted)]">
                  No matches.
                </p>
              ) : null}

              {results.length > 0 ? (
                <div className="rounded border border-[var(--color-border)] bg-white max-h-64 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="text-[var(--color-ink-muted)] sticky top-0 bg-[var(--color-surface-alt)]">
                      <tr>
                        <th className="text-left px-3 py-1.5 font-normal">
                          Type
                        </th>
                        <th className="text-left px-3 py-1.5 font-normal">
                          Name
                        </th>
                        <th className="text-left px-3 py-1.5 font-normal">
                          Location
                        </th>
                        <th className="text-left px-3 py-1.5 font-normal w-12">
                          Pick
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.map((r) => {
                        const isPicked =
                          picked?.veeva_account_id === r.veeva_account_id;
                        return (
                          <tr
                            key={r.veeva_account_id}
                            className={
                              "border-t border-[var(--color-border)] " +
                              (isPicked
                                ? "bg-[var(--color-positive)]/10"
                                : "")
                            }
                          >
                            <td className="px-3 py-1.5">
                              <span
                                className={
                                  "text-xs rounded px-1.5 py-0.5 " +
                                  (r.account_type === "HCP"
                                    ? "bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
                                    : "bg-[var(--color-accent)]/15 text-[var(--color-ink)]")
                                }
                              >
                                {r.account_type}
                              </span>
                            </td>
                            <td className="px-3 py-1.5">{r.name}</td>
                            <td className="px-3 py-1.5 text-[var(--color-ink-muted)]">
                              {[r.city, r.state].filter(Boolean).join(", ") ||
                                "—"}
                            </td>
                            <td className="px-3 py-1.5">
                              <button
                                type="button"
                                onClick={() => setPicked(r)}
                                className="text-[var(--color-primary)] hover:underline text-xs"
                              >
                                {isPicked ? "✓" : "Pick"}
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : null}

              {picked ? (
                <form action={saveAction} className="flex items-end gap-2 pt-2">
                  <input
                    type="hidden"
                    name="distributor_account_id"
                    value={row.sourceKey}
                  />
                  <input
                    type="hidden"
                    name="distributor_account_name"
                    value={row.notes ?? ""}
                  />
                  <input
                    type="hidden"
                    name="veeva_account_id"
                    value={picked.veeva_account_id}
                  />
                  <input
                    type="hidden"
                    name="veeva_account_name"
                    value={picked.name}
                  />
                  <div className="text-xs text-[var(--color-ink-muted)] flex-1">
                    Will re-map{" "}
                    <span className="font-mono">{row.sourceKey}</span> →{" "}
                    <span className="font-medium">
                      {picked.name} ({picked.account_type})
                    </span>
                  </div>
                  <button
                    type="submit"
                    disabled={savePending}
                    className="px-3 py-1.5 rounded bg-[var(--color-primary)] text-white text-xs hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
                  >
                    {savePending ? "Saving…" : "Save change"}
                  </button>
                </form>
              ) : null}

              {saveState.error ? (
                <p className="text-xs text-[var(--color-negative-deep)]">
                  {saveState.error}
                </p>
              ) : null}
              {saveState.success ? (
                <p className="text-xs text-[var(--color-positive-deep)]">
                  ✓ {saveState.success} — refresh to see this row update.
                </p>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
