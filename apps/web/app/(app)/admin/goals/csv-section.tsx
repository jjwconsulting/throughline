"use client";

import { useActionState } from "react";
import { uploadGoalsAction, type UploadGoalsState } from "./actions";

const initial: UploadGoalsState = { saved: 0, rowResults: [] };

export default function CsvSection({
  periodLabel,
  metric = "calls",
}: {
  periodLabel: string; // canonical "2026-Q3" / "2026-05" / "2026" — drives the download URL
  metric?: "calls" | "units";
}) {
  const [state, formAction, isPending] = useActionState(
    uploadGoalsAction,
    initial,
  );

  const errorCount = state.rowResults.filter((r) => r.status === "error").length;

  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-5 space-y-4">
      <div>
        <h2 className="font-display text-xl">CSV upload</h2>
        <p className="text-xs text-[var(--color-ink-muted)] mt-1">
          For batch goal entry — download the pre-populated template, edit in
          Excel, upload back. Saves time vs the form for hundreds of reps.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <a
          href={`/api/admin/goals/template?period=${encodeURIComponent(periodLabel)}&metric=${encodeURIComponent(metric)}`}
          className="px-3 py-1.5 rounded border border-[var(--color-border)] text-sm hover:bg-[var(--color-surface-alt)]"
        >
          ↓ Download template ({periodLabel})
        </a>

        <form action={formAction} className="flex items-end gap-2">
          <label className="text-xs text-[var(--color-ink-muted)]">
            <span className="block mb-1">Upload edited CSV</span>
            <input
              type="file"
              name="file"
              accept=".csv,text/csv"
              required
              disabled={isPending}
              className="text-sm file:mr-2 file:px-3 file:py-1 file:rounded file:border file:border-[var(--color-border)] file:bg-white file:text-[var(--color-ink)] file:hover:bg-[var(--color-surface-alt)] file:cursor-pointer"
            />
          </label>
          <button
            type="submit"
            disabled={isPending}
            className="px-3 py-1.5 rounded bg-[var(--color-primary)] text-white text-sm hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
          >
            {isPending ? "Uploading…" : "Upload"}
          </button>
        </form>
      </div>

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
            <span>{state.rowResults.length} rows processed</span>
          </div>
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
