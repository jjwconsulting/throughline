"use client";

import { useState, useTransition } from "react";
import { narrateRowAction } from "./actions";

// Plain button (no nested <form>) so it works inside the goals-save form.
// Clicks call the server action directly via a transition.
export default function NarrationButton({
  entityLabel,
  metricLabel,
  recommendationJson,
}: {
  entityLabel: string;
  metricLabel: string;
  recommendationJson: string;
}) {
  const [narrative, setNarrative] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleClick() {
    setError(null);
    startTransition(async () => {
      const fd = new FormData();
      fd.set("entity_label", entityLabel);
      fd.set("metric_label", metricLabel);
      fd.set("recommendation", recommendationJson);
      const result = await narrateRowAction(
        { narrative: null, error: null },
        fd,
      );
      if (result.narrative) setNarrative(result.narrative);
      if (result.error) setError(result.error);
    });
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={handleClick}
        disabled={isPending || !!narrative}
        title="Explain this recommendation"
        className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full border border-[var(--color-border)] text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-alt)] disabled:opacity-50 text-xs leading-none"
      >
        {isPending ? "…" : "?"}
      </button>
      {narrative ? (
        <p className="text-xs text-[var(--color-ink)] italic max-w-md mt-2">
          {narrative}
        </p>
      ) : null}
      {error ? (
        <p className="text-xs text-[var(--color-negative-deep)] mt-1">{error}</p>
      ) : null}
    </div>
  );
}
