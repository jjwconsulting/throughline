"use client";

import { useActionState, useState } from "react";
import { saveGoalsAction, type SaveGoalsState } from "./actions";
import NarrationButton from "./narration-button";

const initial: SaveGoalsState = { error: null, saved: 0 };

export type RepGoalRow = {
  user_key: string;
  name: string;
  title: string | null;
  recommended: number;
  method: string;
  rationale: string;
  // Serialized GoalRecommendation — passed to the on-demand narration action
  // so it doesn't need to re-query Fabric to explain. Stored as a JSON
  // string to keep the prop API cheap.
  recommendation_json: string;
  // Optional pre-existing saved goal (for the same period). When present,
  // it pre-fills the input instead of the recommendation.
  existing_value: number | null;
  existing_source: string | null;
};

export default function GoalsForm({
  rows,
  periodStart,
  periodEnd,
  periodType,
  metric,
  periodLabel,
}: {
  rows: RepGoalRow[];
  periodStart: string;
  periodEnd: string;
  periodType: "month" | "quarter" | "year" | "custom";
  metric: "calls" | "units" | "revenue" | "reach_pct" | "frequency";
  // Human label for the period — used by the LLM narration prompt.
  periodLabel: string;
}) {
  const [state, formAction, isPending] = useActionState(
    saveGoalsAction,
    initial,
  );

  // Track per-row dirty state so we can show "modified" badges. Initialized
  // from the recommendation; existing saved goal pre-fills if present.
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const r of rows) {
      const seed = r.existing_value ?? r.recommended;
      initial[r.user_key] = String(seed);
    }
    return initial;
  });

  function set(userKey: string, v: string) {
    setValues((prev) => ({ ...prev, [userKey]: v }));
  }

  function applyAllRecommendations() {
    setValues(
      Object.fromEntries(rows.map((r) => [r.user_key, String(r.recommended)])),
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="period_start" value={periodStart} />
      <input type="hidden" name="period_end" value={periodEnd} />
      <input type="hidden" name="period_type" value={periodType} />
      <input type="hidden" name="metric" value={metric} />

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          {state.error ? (
            <p className="text-sm text-[var(--color-negative)]">{state.error}</p>
          ) : null}
          {state.saved > 0 ? (
            <p className="text-sm text-[var(--color-positive)]">
              Saved {state.saved} goal{state.saved === 1 ? "" : "s"}.
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={applyAllRecommendations}
            disabled={isPending}
            className="px-3 py-1.5 rounded border border-[var(--color-border)] text-xs text-[var(--color-ink)] hover:bg-[var(--color-surface-alt)] disabled:opacity-50"
          >
            Reset all to recommended
          </button>
          <button
            type="submit"
            disabled={isPending}
            className="px-4 py-1.5 rounded bg-[var(--color-primary)] text-white text-sm hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
          >
            {isPending ? "Saving…" : `Save ${rows.length} goals`}
          </button>
        </div>
      </div>

      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)]">
            <tr>
              <th className="text-left px-4 py-2 font-normal">Rep</th>
              <th className="text-right px-4 py-2 font-normal">Recommended</th>
              <th className="text-left px-4 py-2 font-normal">Goal</th>
              <th className="text-left px-4 py-2 font-normal">Status</th>
              <th className="text-left px-4 py-2 font-normal">Rationale</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const current = values[r.user_key] ?? "";
              const currentNum = Number(current);
              const isDirty =
                Number.isFinite(currentNum) &&
                Math.round(currentNum) !== Math.round(r.recommended);
              const hasExisting = r.existing_value != null;
              return (
                <tr
                  key={r.user_key}
                  className="border-t border-[var(--color-border)] align-top"
                >
                  <td className="px-4 py-3">
                    <div className="font-medium">{r.name}</div>
                    {r.title ? (
                      <div className="text-xs text-[var(--color-ink-muted)]">
                        {r.title}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[var(--color-ink-muted)]">
                    {r.recommended.toLocaleString("en-US")}
                  </td>
                  <td className="px-4 py-3">
                    <input
                      type="number"
                      min="0"
                      step="1"
                      name={`value_${r.user_key}`}
                      value={current}
                      onChange={(e) => set(r.user_key, e.target.value)}
                      disabled={isPending}
                      className="w-28 px-2 py-1 rounded border border-[var(--color-border)] bg-white font-mono text-sm"
                    />
                    <input
                      type="hidden"
                      name={`recommended_${r.user_key}`}
                      value={r.recommended}
                    />
                  </td>
                  <td className="px-4 py-3">
                    {isDirty ? (
                      <span className="text-xs rounded px-2 py-0.5 bg-[var(--color-accent)]/15 text-[var(--color-ink)]">
                        Modified
                      </span>
                    ) : hasExisting && r.existing_source === "manual" ? (
                      <span className="text-xs rounded px-2 py-0.5 bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)] border border-[var(--color-border)]">
                        Saved (manual)
                      </span>
                    ) : hasExisting ? (
                      <span className="text-xs rounded px-2 py-0.5 bg-[var(--color-positive)]/15 text-[var(--color-positive)]">
                        Saved (rec)
                      </span>
                    ) : (
                      <span className="text-xs text-[var(--color-ink-muted)]">
                        New
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-[var(--color-ink-muted)] max-w-md">
                    <div className="flex items-start gap-2">
                      <div className="flex-1">{r.rationale}</div>
                      <NarrationButton
                        entityLabel={r.name}
                        metricLabel={`${periodLabel} ${metric}`}
                        recommendationJson={r.recommendation_json}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </form>
  );
}
