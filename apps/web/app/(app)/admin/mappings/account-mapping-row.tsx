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
  account_city?: string | null;
  account_state: string | null;
  account_postal_code?: string | null;
  rows: number;
  signed_gross_dollars: number | null;
  last_seen: string | null;
};

export type SuggestionPill = {
  veeva_account_id: string;
  account_type: "HCP" | "HCO";
  name: string;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  detail: string | null;
  score: number;
};

// Per-unmapped-row component. Renders the row + a collapsible search-and-pick
// panel. Keeps results local to this row so multiple rows can be mapped
// without cross-talk.
export default function AccountMappingRow({
  row,
  suggestions = [],
}: {
  row: UnmappedRowProps;
  // Top fuzzy-name suggestions (state-filtered). Empty when nothing scored
  // above the confidence threshold. Lighter framing than "recommendations":
  // just a starting point; admin still owns the final pick.
  suggestions?: SuggestionPill[];
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
          {row.account_city || row.account_state ? (
            <div className="text-xs text-[var(--color-ink-muted)]">
              {[row.account_city, row.account_state].filter(Boolean).join(", ")}
            </div>
          ) : null}
          {suggestions.length > 0 && !saveState.success ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] self-center">
                Suggested:
              </span>
              {suggestions.map((s) => (
                <form
                  key={s.veeva_account_id}
                  action={saveAction}
                  className="inline"
                >
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
                    value={s.veeva_account_id}
                  />
                  <input
                    type="hidden"
                    name="veeva_account_name"
                    value={s.name}
                  />
                  <button
                    type="submit"
                    disabled={savePending}
                    title={`${s.name} (${s.account_type}${s.city || s.state ? " · " + [s.city, s.state].filter(Boolean).join(", ") : ""}) — ${Math.round(s.score * 100)}% match. Click to map.`}
                    className="text-xs rounded border border-[var(--color-border)] bg-white px-2 py-0.5 hover:bg-[var(--color-positive)]/10 hover:border-[var(--color-positive)] disabled:opacity-50"
                  >
                    <span className="text-[var(--color-ink-muted)] mr-1">
                      {s.account_type}
                    </span>
                    {s.name}
                    <span className="text-[var(--color-ink-muted)] ml-1">
                      ≈{Math.round(s.score * 100)}%
                    </span>
                  </button>
                </form>
              ))}
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
                <p className="text-xs text-[var(--color-negative-deep)]">
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
            className="px-4 py-2 text-xs text-[var(--color-positive-deep)]"
          >
            ✓ {saveState.success} — run config_sync + silver_account_xref_build
            + gold_fact_sale_build to see this account resolve in the dashboard.
          </td>
        </tr>
      ) : null}
    </>
  );
}
