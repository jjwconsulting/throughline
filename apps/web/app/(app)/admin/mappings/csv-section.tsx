"use client";

import { useActionState, useMemo, useRef, useState } from "react";
import { uploadMappingsAction, type UploadMappingsState } from "./actions";

const initial: UploadMappingsState = { saved: 0, rowResults: [] };

// Logical fields the action needs. We translate "user's column header" →
// these names via FormData "col_*" overrides on submit.
const REQUIRED_FIELDS = [
  { key: "distributor_account_id", label: "Distributor account ID", required: true },
  { key: "veeva_account_id", label: "Veeva account ID", required: true },
  { key: "distributor_account_name", label: "Distributor name (optional)", required: false },
] as const;

type RequiredFieldKey = (typeof REQUIRED_FIELDS)[number]["key"];

// Parse a CSV string into a 2D array. Mirrors the server-side parser:
// strips BOM, skips '#' comment lines and blank lines, handles quoted
// fields with embedded commas. We only parse the file once on the client
// to drive the preview + auto-detect; the server re-parses on submit.
function parseCsv(text: string): string[][] {
  const stripBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = stripBom.split(/\r?\n/);
  const rows: string[][] = [];
  for (const raw of lines) {
    if (raw.length === 0) continue;
    if (raw.startsWith("#")) continue;
    rows.push(splitCsvLine(raw));
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

// Best-effort header auto-detect. Matches exact field names first
// (case-insensitive), then a small synonym list per field for common
// shapes seen in transitioning-client files. Anything unmatched stays
// blank for the admin to pick.
const SYNONYMS: Record<RequiredFieldKey, string[]> = {
  distributor_account_id: [
    "distributor_account_id",
    "customer_id",
    "customer id",
    "account_id",
    "account id",
    "customer number",
    "customer #",
    "dea",
    "dea number",
    "dea #",
    "hin",
    "ship_to",
    "ship to id",
    "ship-to id",
  ],
  veeva_account_id: [
    "veeva_account_id",
    "veeva id",
    "veeva account id",
    "veeva customer id",
    "veeva customer #",
    "veeva account #",
    "vid",
  ],
  distributor_account_name: [
    "distributor_account_name",
    "customer_name",
    "customer name",
    "account_name",
    "account name",
    "name",
  ],
};

function autoDetect(headers: string[]): Record<RequiredFieldKey, string> {
  const lower = headers.map((h) => h.toLowerCase().trim());
  const result: Record<RequiredFieldKey, string> = {
    distributor_account_id: "",
    veeva_account_id: "",
    distributor_account_name: "",
  };
  for (const field of REQUIRED_FIELDS) {
    for (const candidate of SYNONYMS[field.key]) {
      const idx = lower.indexOf(candidate);
      if (idx >= 0) {
        result[field.key] = headers[idx]!;
        break;
      }
    }
  }
  return result;
}

export default function CsvSection() {
  const [state, formAction, isPending] = useActionState(
    uploadMappingsAction,
    initial,
  );
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [headers, setHeaders] = useState<string[] | null>(null);
  const [sampleRows, setSampleRows] = useState<string[][]>([]);
  const [parseError, setParseError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<Record<RequiredFieldKey, string>>({
    distributor_account_id: "",
    veeva_account_id: "",
    distributor_account_name: "",
  });
  const [totalRows, setTotalRows] = useState(0);

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) {
      setHeaders(null);
      setSampleRows([]);
      setParseError(null);
      setTotalRows(0);
      return;
    }
    if (file.size > 5_000_000) {
      setParseError("File too large (max 5MB).");
      setHeaders(null);
      setSampleRows([]);
      return;
    }
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      if (rows.length === 0) {
        setParseError("Empty file.");
        setHeaders(null);
        setSampleRows([]);
        return;
      }
      const fileHeaders = rows[0]!;
      const samples = rows.slice(1, 6);
      setHeaders(fileHeaders);
      setSampleRows(samples);
      setMapping(autoDetect(fileHeaders));
      setTotalRows(Math.max(0, rows.length - 1));
      setParseError(null);
    } catch (err) {
      setParseError(
        `Could not read file: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const ready = useMemo(
    () =>
      headers != null &&
      mapping.distributor_account_id !== "" &&
      mapping.veeva_account_id !== "",
    [headers, mapping],
  );

  const errorCount = state.rowResults.filter((r) => r.status === "error").length;
  const allHeaderOptions = headers ?? [];

  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-5 space-y-4">
      <div>
        <h2 className="font-display text-xl">CSV upload</h2>
        <p className="text-xs text-[var(--color-ink-muted)] mt-1">
          For day-1 setup or large batches. Drop in any mapping file —
          our template, an export from a prior tool, or your own
          spreadsheet — then confirm which columns are which. Idempotent:
          re-uploading updates existing mappings.
        </p>
      </div>

      <form action={formAction} className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <a
            href="/api/admin/mappings/template"
            className="px-3 py-1.5 rounded border border-[var(--color-border)] text-sm hover:bg-[var(--color-surface-alt)]"
          >
            ↓ Download template
          </a>

          <label className="text-xs text-[var(--color-ink-muted)]">
            <span className="block mb-1">Upload CSV</span>
            <input
              ref={fileInputRef}
              type="file"
              name="file"
              accept=".csv,text/csv"
              required
              disabled={isPending}
              onChange={handleFileChange}
              className="text-sm file:mr-2 file:px-3 file:py-1 file:rounded file:border file:border-[var(--color-border)] file:bg-white file:text-[var(--color-ink)] file:hover:bg-[var(--color-surface-alt)] file:cursor-pointer"
            />
          </label>
        </div>

        {parseError ? (
          <p className="text-xs text-[var(--color-negative)]">{parseError}</p>
        ) : null}

        {headers ? (
          <div className="space-y-3">
            <div>
              <p className="text-xs text-[var(--color-ink-muted)] mb-1">
                Detected {headers.length} column{headers.length === 1 ? "" : "s"}
                {totalRows > 0
                  ? ` and ${totalRows.toLocaleString()} data row${totalRows === 1 ? "" : "s"}.`
                  : "."}{" "}
                Confirm which column maps to which Throughline field — we
                pre-fill obvious matches.
              </p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                {REQUIRED_FIELDS.map((f) => (
                  <label key={f.key} className="text-xs space-y-1">
                    <span className="block text-[var(--color-ink-muted)]">
                      {f.label}
                      {f.required ? (
                        <span className="text-[var(--color-negative)] ml-1">*</span>
                      ) : null}
                    </span>
                    <select
                      name={`col_${f.key}`}
                      value={mapping[f.key]}
                      onChange={(e) =>
                        setMapping((m) => ({ ...m, [f.key]: e.target.value }))
                      }
                      disabled={isPending}
                      className="w-full px-2 py-1.5 rounded border border-[var(--color-border)] bg-white text-sm"
                    >
                      <option value="">— not in file —</option>
                      {allHeaderOptions.map((h) => (
                        <option key={h} value={h}>
                          {h}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>

            {sampleRows.length > 0 ? (
              <details className="text-xs">
                <summary className="cursor-pointer text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]">
                  Preview first {sampleRows.length} row
                  {sampleRows.length === 1 ? "" : "s"}
                </summary>
                <div className="mt-2 overflow-x-auto rounded border border-[var(--color-border)]">
                  <table className="w-full text-xs">
                    <thead className="bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)]">
                      <tr>
                        {headers.map((h) => (
                          <th
                            key={h}
                            className="text-left font-normal px-2 py-1 whitespace-nowrap"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sampleRows.map((r, i) => (
                        <tr
                          key={i}
                          className="border-t border-[var(--color-border)]"
                        >
                          {headers.map((_, j) => (
                            <td
                              key={j}
                              className="px-2 py-1 whitespace-nowrap font-mono"
                            >
                              {r[j] ?? ""}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ) : null}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={isPending || !ready}
          className="px-4 py-1.5 rounded bg-[var(--color-primary)] text-white text-sm hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
        >
          {isPending
            ? "Uploading…"
            : ready
              ? `Import ${totalRows.toLocaleString()} row${totalRows === 1 ? "" : "s"}`
              : "Pick file + map columns"}
        </button>
      </form>

      {state.rowResults.length > 0 ? (
        <div className="rounded border border-[var(--color-border)] overflow-hidden">
          <div className="px-4 py-2 bg-[var(--color-surface-alt)] text-xs text-[var(--color-ink-muted)] flex items-center justify-between">
            <span>
              <span className="text-[var(--color-positive)]">
                {state.saved} saved
              </span>
              {errorCount > 0 ? (
                <>
                  {" · "}
                  <span className="text-[var(--color-negative)]">
                    {errorCount} error{errorCount === 1 ? "" : "s"}
                  </span>
                </>
              ) : null}
            </span>
            <span>{state.rowResults.length} row(s) reported</span>
          </div>
          {state.resolutionBreakdown && state.resolutionBreakdown.length > 0 ? (
            <div className="px-4 py-2 border-t border-[var(--color-border)] text-xs text-[var(--color-ink-muted)] flex flex-wrap gap-2">
              <span>Resolved via:</span>
              {state.resolutionBreakdown.map((b) => (
                <span
                  key={b.field}
                  className="rounded bg-[var(--color-surface-alt)] px-1.5 py-0.5 text-[var(--color-ink)]"
                >
                  {b.label}{" "}
                  <span className="text-[var(--color-ink-muted)]">
                    × {b.count}
                  </span>
                </span>
              ))}
            </div>
          ) : null}
          <ul className="divide-y divide-[var(--color-border)] text-xs max-h-64 overflow-y-auto">
            {state.rowResults.map((r, i) => (
              <li
                key={i}
                className={
                  "px-4 py-1.5 " +
                  (r.status === "error"
                    ? "text-[var(--color-negative)]"
                    : "text-[var(--color-ink-muted)]")
                }
              >
                <span className="font-mono mr-2">L{r.line}</span>
                {r.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
