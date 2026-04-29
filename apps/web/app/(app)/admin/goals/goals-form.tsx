"use client";

import { useActionState, useState } from "react";
import { saveGoalsAction, type SaveGoalsState } from "./actions";
import NarrationButton from "./narration-button";

const initial: SaveGoalsState = { error: null, saved: 0 };

// Generic over goal entity (rep or territory). For rep goals: entity_id =
// dim_user.user_key, name = rep name, subtitle = title. For territory
// goals: entity_id = dim_territory.territory_key, name = territory name,
// subtitle = current rep's name (display context — the actual current
// rep on a territory; goals follow the territory if rep changes).
export type EntityGoalRow = {
  entity_id: string;
  name: string;
  subtitle: string | null;
  recommended: number;
  method: string;
  rationale: string;
  // Serialized GoalRecommendation — passed to the on-demand narration
  // action so it doesn't re-query Fabric to explain.
  recommendation_json: string;
  // Optional pre-existing saved goal for this entity + period.
  existing_value: number | null;
  existing_source: string | null;
};

export default function GoalsForm({
  rows,
  periodStart,
  periodEnd,
  periodType,
  metric,
  entityType,
  periodLabel,
  entityNoun,
}: {
  rows: EntityGoalRow[];
  periodStart: string;
  periodEnd: string;
  periodType: "month" | "quarter" | "year" | "custom";
  metric: "calls" | "units" | "revenue" | "reach_pct" | "frequency";
  entityType: "rep" | "territory";
  periodLabel: string;
  // Display label for the entity column header — "Rep" or "Territory".
  entityNoun: string;
}) {
  const [state, formAction, isPending] = useActionState(
    saveGoalsAction,
    initial,
  );

  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const r of rows) {
      const seed = r.existing_value ?? r.recommended;
      initial[r.entity_id] = String(seed);
    }
    return initial;
  });

  function set(entityId: string, v: string) {
    setValues((prev) => ({ ...prev, [entityId]: v }));
  }

  function applyAllRecommendations() {
    setValues(
      Object.fromEntries(rows.map((r) => [r.entity_id, String(r.recommended)])),
    );
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="period_start" value={periodStart} />
      <input type="hidden" name="period_end" value={periodEnd} />
      <input type="hidden" name="period_type" value={periodType} />
      <input type="hidden" name="metric" value={metric} />
      <input type="hidden" name="entity_type" value={entityType} />

      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="text-sm text-[var(--color-ink-muted)]">
          {state.error ? (
            <span className="text-[var(--color-negative-deep)]">{state.error}</span>
          ) : state.saved > 0 ? (
            <span className="text-[var(--color-positive-deep)]">
              ✓ Saved {state.saved} goal{state.saved === 1 ? "" : "s"}
            </span>
          ) : (
            <>
              {rows.length} {entityNoun.toLowerCase()}
              {rows.length === 1 ? "" : "s"}
            </>
          )}
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={applyAllRecommendations}
            disabled={isPending}
            className="px-3 py-1.5 rounded border border-[var(--color-border)] text-sm hover:bg-[var(--color-surface-alt)] disabled:opacity-50"
          >
            Reset all to recommended
          </button>
          <button
            type="submit"
            disabled={isPending}
            className="px-3 py-1.5 rounded bg-[var(--color-primary)] text-white text-sm hover:bg-[var(--color-primary-hover)] disabled:opacity-50"
          >
            {isPending ? "Saving…" : `Save ${rows.length} goals`}
          </button>
        </div>
      </div>

      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)]">
            <tr>
              <th className="text-left px-4 py-2 font-normal">{entityNoun}</th>
              <th className="text-right px-4 py-2 font-normal">Recommended</th>
              <th className="text-left px-4 py-2 font-normal">Goal</th>
              <th className="text-left px-4 py-2 font-normal">Status</th>
              <th className="text-left px-4 py-2 font-normal">Rationale</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const current = values[r.entity_id] ?? "";
              const currentNum = Number(current);
              const isDirty =
                Number.isFinite(currentNum) &&
                Math.round(currentNum) !== Math.round(r.recommended);
              const hasExisting = r.existing_value != null;
              return (
                <tr
                  key={r.entity_id}
                  className="border-t border-[var(--color-border)] align-top"
                >
                  <td className="px-4 py-3">
                    <div className="font-medium">{r.name}</div>
                    {r.subtitle ? (
                      <div className="text-xs text-[var(--color-ink-muted)]">
                        {r.subtitle}
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
                      name={`value_${r.entity_id}`}
                      value={current}
                      onChange={(e) => set(r.entity_id, e.target.value)}
                      disabled={isPending}
                      className="w-28 px-2 py-1 rounded border border-[var(--color-border)] bg-white font-mono text-sm"
                    />
                    <input
                      type="hidden"
                      name={`recommended_${r.entity_id}`}
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
                      <span className="text-xs rounded px-2 py-0.5 bg-[var(--color-positive)]/15 text-[var(--color-positive-deep)]">
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
