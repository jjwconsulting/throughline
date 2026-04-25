"use client";

import { useActionState, useState, useTransition } from "react";
import {
  saveAccountMappingAction,
  searchVeevaAccountsAction,
  type SaveMappingState,
  type VeevaAccountMatch,
} from "./actions";

const initialSave: SaveMappingState = { error: null, success: null };

export type UnmappedRowProps = {
  distributor_account_id: string;
  distributor_account_name: string | null;
  account_state: string | null;
  rows: number;
  signed_gross_dollars: number | null;
  last_seen: string | null;
};

// Per-unmapped-row component. Renders the row + a collapsible search-and-pick
// panel. Keeps results local to this row so multiple rows can be mapped
// without cross-talk.
export default function AccountMappingRow({
  row,
}: {
  row: UnmappedRowProps;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(row.distributor_account_name ?? "");
  const [results, setResults] = useState<VeevaAccountMatch[]>([]);
  const [searchPending, startSearch] = useTransition();
  const [picked, setPicked] = useState<VeevaAccountMatch | null>(null);
  const [saveState, saveAction, savePending] = useActionState(
    saveAccountMappingAction,
    initialSave,
  );

  function runSearch(q: string) {
    setQuery(q);
    startSearch(async () => {
      const matches = await searchVeevaAccountsAction(q, "ALL");
      setResults(matches);
    });
  }

  return (
    <>
      <tr className="border-t border-[var(--color-border)] align-top hover:bg-[var(--color-surface-alt)]">
        <td className="px-4 py-3 font-mono text-xs">
          {row.distributor_account_id}
        </td>
        <td className="px-4 py-3">
          <div className="font-medium">{row.distributor_account_name ?? "—"}</div>
          {row.account_state ? (
            <div className="text-xs text-[var(--color-ink-muted)]">
              {row.account_state}
            </div>
          ) : null}
        </td>
        <td className="px-4 py-3 text-right text-xs text-[var(--color-ink-muted)]">
          {row.rows.toLocaleString()}
        </td>
        <td className="px-4 py-3 text-right text-xs text-[var(--color-ink-muted)] font-mono">
          {row.signed_gross_dollars != null
            ? `$${Math.round(row.signed_gross_dollars).toLocaleString()}`
            : "—"}
        </td>
        <td className="px-4 py-3 text-right text-xs text-[var(--color-ink-muted)]">
          {row.last_seen ?? "—"}
        </td>
        <td className="px-4 py-3">
          <button
            type="button"
            onClick={() => {
              setOpen((o) => !o);
              if (!open && results.length === 0) {
                runSearch(query);
              }
            }}
            className="px-3 py-1 rounded border border-[var(--color-border)] text-xs hover:bg-[var(--color-surface)] disabled:opacity-50"
          >
            {saveState.success ? "✓ Mapped" : open ? "Cancel" : "Map →"}
          </button>
        </td>
      </tr>
      {open && !saveState.success ? (
        <tr className="border-t border-[var(--color-border)] bg-[var(--color-surface-alt)]">
          <td colSpan={6} className="px-4 py-4">
            <div className="space-y-3">
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
                />
              </div>

              {searchPending ? (
                <p className="text-xs text-[var(--color-ink-muted)]">Searching…</p>
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
                        <th className="text-left px-3 py-1.5 font-normal">
                          Detail
                        </th>
                        <th className="text-left px-3 py-1.5 font-normal w-12">
                          Pick
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {results.map((r) => {
                        const isPicked = picked?.veeva_account_id === r.veeva_account_id;
                        return (
                          <tr
                            key={r.veeva_account_id}
                            className={
                              "border-t border-[var(--color-border)] " +
                              (isPicked ? "bg-[var(--color-positive)]/10" : "")
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
                              {[r.city, r.state].filter(Boolean).join(", ") || "—"}
                            </td>
                            <td className="px-3 py-1.5 text-[var(--color-ink-muted)]">
                              {r.detail ?? "—"}
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
                    value={row.distributor_account_id}
                  />
                  <input
                    type="hidden"
                    name="distributor_account_name"
                    value={row.distributor_account_name ?? ""}
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
                    Will map{" "}
                    <span className="font-medium">
                      {row.distributor_account_name ?? row.distributor_account_id}
                    </span>{" "}
                    →{" "}
                    <span className="font-medium">
                      {picked.name} ({picked.account_type})
                    </span>
                  </div>
                  <button
                    type="submit"
                    disabled={savePending}
                    className="px-3 py-1.5 rounded bg-[var(--color-primary)] text-white text-xs hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
                  >
                    {savePending ? "Saving…" : "Save mapping"}
                  </button>
                </form>
              ) : null}

              {saveState.error ? (
                <p className="text-xs text-[var(--color-negative)]">
                  {saveState.error}
                </p>
              ) : null}
            </div>
          </td>
        </tr>
      ) : null}
      {saveState.success ? (
        <tr className="border-t border-[var(--color-border)]">
          <td
            colSpan={6}
            className="px-4 py-2 text-xs text-[var(--color-positive)]"
          >
            ✓ {saveState.success} — run config_sync + silver_account_xref_build
            + gold_fact_sale_build to see this account resolve in the dashboard.
          </td>
        </tr>
      ) : null}
    </>
  );
}
