"use client";

import { useState, useTransition, useMemo } from "react";
import {
  createAttributeMappingAction,
  listBronzeColumnsAction,
} from "./actions";

// Inline pure helper: suggest a clean canonical attribute name from a
// raw bronze column. Lives here (not in lib/bronze-introspection)
// because that file pulls in mssql/tedious for the listBronze* server
// helpers, and importing it from a client component bundles Node-only
// deps (dgram etc.) which fails the browser build.
function suggestAttributeName(bronzeColumn: string): string {
  let s = bronzeColumn;
  // Strip Veeva trailing markers
  s = s.replace(/__[cv]$/, "");
  // Strip common per-tenant year+prefix patterns (e.g. fen_2024_)
  s = s.replace(/^[a-z]{2,4}_\d{4}_/, "");
  // Strip simple per-tenant prefixes
  s = s.replace(/^(fen|tri|trl|clarivate|komodo|iqvia|internal)_/, "");
  return s;
}

// Add-mapping form for /admin/attributes with cascading pickers:
//   1. Source system (enum) → filters available bronze tables
//   2. Bronze table (preloaded list of tables in tenant's bronze schema)
//   3. Bronze column (lazy-fetched from selected table)
//   4. Attribute name (auto-suggested from column; editable)
//   5. Entity / type / source label / scope tag (manual)
//
// Re-submitting the same (source / table / column) updates via
// ON CONFLICT DO UPDATE in the action — admins fix typos by re-saving.

const ENTITY_TYPES = [
  { value: "hcp", label: "HCP" },
  { value: "hco", label: "HCO" },
] as const;
const ATTRIBUTE_TYPES = [
  { value: "decile", label: "Decile (1-10)" },
  { value: "score", label: "Score (numeric)" },
  { value: "volume", label: "Volume (count)" },
  { value: "percentile", label: "Percentile (0-100)" },
  { value: "categorical", label: "Categorical (string)" },
  { value: "flag", label: "Flag (boolean)" },
] as const;

export type BronzeTableOption = {
  source_system: "veeva" | "sftp" | "email" | "hubspot";
  table_name: string;
};

export default function AttributeForm({
  bronzeTables,
}: {
  bronzeTables: BronzeTableOption[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  // Cascading state: source → table → column.
  const [sourceSystem, setSourceSystem] = useState<string>("");
  const [bronzeTable, setBronzeTable] = useState<string>("");
  const [bronzeColumn, setBronzeColumn] = useState<string>("");
  const [attributeName, setAttributeName] = useState<string>("");

  const [columns, setColumns] = useState<{ column_name: string; data_type: string }[]>([]);
  const [columnsLoading, setColumnsLoading] = useState(false);
  const [columnsError, setColumnsError] = useState<string | null>(null);

  // Source systems present in the actual bronze schema (don't show
  // "veeva" if no veeva_obj_* tables exist for this tenant).
  const availableSources = useMemo(
    () => Array.from(new Set(bronzeTables.map((t) => t.source_system))),
    [bronzeTables],
  );
  const tablesForSource = useMemo(
    () =>
      sourceSystem
        ? bronzeTables.filter((t) => t.source_system === sourceSystem)
        : [],
    [sourceSystem, bronzeTables],
  );

  function handleSourceChange(v: string) {
    setSourceSystem(v);
    setBronzeTable("");
    setBronzeColumn("");
    setAttributeName("");
    setColumns([]);
    setColumnsError(null);
  }

  function handleTableChange(v: string) {
    setBronzeTable(v);
    setBronzeColumn("");
    setAttributeName("");
    setColumns([]);
    setColumnsError(null);
    if (!v) return;
    setColumnsLoading(true);
    listBronzeColumnsAction(v).then((res) => {
      setColumnsLoading(false);
      if (!res.ok) {
        setColumnsError(res.error);
        return;
      }
      setColumns(res.columns);
    });
  }

  function handleColumnChange(v: string) {
    setBronzeColumn(v);
    if (v) setAttributeName(suggestAttributeName(v));
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    const formData = new FormData(e.currentTarget);
    const form = e.currentTarget;
    startTransition(async () => {
      const res = await createAttributeMappingAction(formData);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setSuccess(
        `Saved mapping for ${formData.get("attribute_name")}. Re-submit the same bronze location to update.`,
      );
      // Reset cascading state + form fields.
      form.reset();
      setSourceSystem("");
      setBronzeTable("");
      setBronzeColumn("");
      setAttributeName("");
      setColumns([]);
    });
  }

  if (bronzeTables.length === 0) {
    return (
      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-5 text-sm text-[var(--color-ink-muted)]">
        <p>
          No bronze tables found for this tenant. Make sure the tenant has
          had a successful Veeva or SFTP ingest run; the attribute form
          populates dropdowns from the bronze schema.
        </p>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-5 space-y-4"
    >
      <div>
        <h3 className="font-display text-lg">Add attribute mapping</h3>
        <p className="text-xs text-[var(--color-ink-muted)]">
          Pick a source → table → column from this tenant&apos;s bronze data,
          then describe how to interpret it. Re-submit the same bronze
          location to update.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Field label="Source system">
          <select
            name="source_system"
            required
            value={sourceSystem}
            onChange={(e) => handleSourceChange(e.target.value)}
            className={selectClass}
          >
            <option value="" disabled>
              Pick…
            </option>
            {availableSources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Bronze table">
          <select
            name="bronze_table"
            required
            value={bronzeTable}
            onChange={(e) => handleTableChange(e.target.value)}
            disabled={!sourceSystem}
            className={selectClass}
          >
            <option value="" disabled>
              {sourceSystem ? "Pick a table…" : "Pick source first"}
            </option>
            {tablesForSource.map((t) => (
              <option key={t.table_name} value={t.table_name}>
                {t.table_name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Bronze column">
          <select
            name="bronze_column"
            required
            value={bronzeColumn}
            onChange={(e) => handleColumnChange(e.target.value)}
            disabled={!bronzeTable || columnsLoading}
            className={selectClass}
          >
            <option value="" disabled>
              {!bronzeTable
                ? "Pick a table first"
                : columnsLoading
                  ? "Loading columns…"
                  : columns.length === 0
                    ? "No columns found"
                    : "Pick a column…"}
            </option>
            {columns.map((c) => (
              <option key={c.column_name} value={c.column_name}>
                {c.column_name} ({c.data_type})
              </option>
            ))}
          </select>
          {columnsError ? (
            <span className="block text-xs text-[var(--color-negative)] mt-1">
              {columnsError}
            </span>
          ) : null}
        </Field>
        <Field label="Attribute name (canonical)">
          <input
            name="attribute_name"
            required
            value={attributeName}
            onChange={(e) => setAttributeName(e.target.value)}
            placeholder="e.g. breast_cancer_decile"
            className={inputClass}
          />
          {bronzeColumn ? (
            <span className="block text-xs text-[var(--color-ink-muted)] mt-1">
              Auto-suggested from column name; edit as needed.
            </span>
          ) : null}
        </Field>
        <Field label="Entity">
          <select name="entity_type" required className={selectClass} defaultValue="">
            <option value="" disabled>
              Pick…
            </option>
            {ENTITY_TYPES.map((e) => (
              <option key={e.value} value={e.value}>
                {e.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Attribute type">
          <select name="attribute_type" required className={selectClass} defaultValue="">
            <option value="" disabled>
              Pick…
            </option>
            {ATTRIBUTE_TYPES.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Source label">
          <input
            name="source_label"
            required
            placeholder="e.g. komodo_2024_q4"
            className={inputClass}
          />
        </Field>
        <Field label="Scope tag (optional)">
          <input
            name="scope_tag"
            placeholder="e.g. breast_cancer"
            className={inputClass}
          />
        </Field>
      </div>

      <div className="flex items-center justify-between gap-4">
        <div className="text-xs">
          {error ? (
            <span className="text-[var(--color-negative)]">{error}</span>
          ) : success ? (
            <span className="text-[var(--color-positive)]">{success}</span>
          ) : null}
        </div>
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-[var(--color-primary)] text-white text-sm px-4 py-2 hover:opacity-90 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save mapping"}
        </button>
      </div>
    </form>
  );
}

const inputClass =
  "w-full rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-ink)] text-sm px-3 py-1.5 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)]";
const selectClass = inputClass + " disabled:opacity-50";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-xs text-[var(--color-ink-muted)] mb-1">
        {label}
      </span>
      {children}
    </label>
  );
}
