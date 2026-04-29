"use client";

import { useActionState } from "react";
import {
  triggerMappingPipelineAction,
  type TriggerPipelineState,
} from "./actions";
import type { LastPipelineRun } from "./load";

const initial: TriggerPipelineState = { error: null, success: null };

// Renders an end-user-friendly representation of a Date. "5 minutes ago"
// for fresh runs, falls back to ISO date for anything beyond a day.
function relativeTime(d: Date): string {
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return d.toISOString().slice(0, 10);
}

const STATUS_LABEL: Record<LastPipelineRun["status"], string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
};

export default function PipelineTrigger({
  lastRun,
}: {
  lastRun: LastPipelineRun | null;
}) {
  const [state, formAction, isPending] = useActionState(
    triggerMappingPipelineAction,
    initial,
  );

  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h2 className="font-display text-xl">Apply mappings to sales</h2>
          <p className="text-xs text-[var(--color-ink-muted)] mt-1 max-w-2xl">
            Run the data sync that propagates your saved mappings into the
            sales attribution. Takes 2&ndash;3 minutes; the dashboard&apos;s
            HCO breakdowns and unmapped totals will refresh once it
            completes. Safe to run multiple times.
          </p>
          {lastRun ? (
            <p className="text-xs text-[var(--color-ink-muted)] mt-2">
              Last run: {relativeTime(lastRun.createdAt)} by{" "}
              <span className="font-mono">{lastRun.triggeredBy}</span> ·
              status:{" "}
              <span
                className={
                  lastRun.status === "failed"
                    ? "text-[var(--color-negative-deep)]"
                    : lastRun.status === "succeeded"
                      ? "text-[var(--color-positive-deep)]"
                      : "text-[var(--color-ink)]"
                }
              >
                {STATUS_LABEL[lastRun.status]}
              </span>
              {lastRun.message ? (
                <span className="text-[var(--color-ink-muted)]"> · {lastRun.message}</span>
              ) : null}
            </p>
          ) : (
            <p className="text-xs text-[var(--color-ink-muted)] mt-2">
              No runs yet for this tenant.
            </p>
          )}
        </div>

        <form action={formAction}>
          <button
            type="submit"
            disabled={isPending}
            className="px-4 py-2 rounded bg-[var(--color-primary)] text-white text-sm hover:bg-[var(--color-primary-hover)] disabled:opacity-50 whitespace-nowrap"
          >
            {isPending ? "Starting…" : "Run sync now"}
          </button>
        </form>
      </div>

      {state.error ? (
        <p className="text-xs text-[var(--color-negative-deep)] mt-3">
          {state.error}
        </p>
      ) : null}
      {state.success ? (
        <p className="text-xs text-[var(--color-positive-deep)] mt-3">
          ✓ {state.success}
        </p>
      ) : null}
    </div>
  );
}
