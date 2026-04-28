"use client";

import { useTransition } from "react";
import { dismissSynopsisAction } from "@/app/(app)/dashboard/synopsis-actions";

// "Since your last visit" card on /dashboard. Renders the LLM-generated
// synopsis plus a Dismiss button that hides the card until the next
// successful pipeline_run lands. Designed to NOT keep nagging — once
// dismissed, the user won't see it again until there's actually new
// data behind it.

export default function SynopsisCard({
  body,
  generatedAt,
}: {
  body: string;
  // ISO timestamp from the cache row — server passes as Date; we
  // accept Date | string for safety.
  generatedAt: Date | string;
}) {
  const [pending, startTransition] = useTransition();

  function dismiss() {
    startTransition(async () => {
      await dismissSynopsisAction();
    });
  }

  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-5 flex items-start gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-2">
          <span className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)]">
            Since your last visit
          </span>
          <span className="text-xs text-[var(--color-ink-muted)]">·</span>
          <span className="text-xs text-[var(--color-ink-muted)]">
            generated {timeAgo(generatedAt)}
          </span>
        </div>
        <p className="text-sm text-[var(--color-ink)] leading-relaxed">
          {body}
        </p>
      </div>
      <button
        type="button"
        onClick={dismiss}
        disabled={pending}
        className="text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)] disabled:opacity-50 whitespace-nowrap"
        title="Hide until the next data refresh"
      >
        {pending ? "Dismissing…" : "Dismiss"}
      </button>
    </div>
  );
}

function timeAgo(d: Date | string): string {
  const ms = Date.now() - new Date(d).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
