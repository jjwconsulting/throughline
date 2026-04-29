"use client";

// Reusable "Generate call brief" button + inline result renderer.
// Used in two surfaces:
//   - /reps/[user_key] action launchpad (per recommendation row)
//   - /hcps/[hcp_key] snapshot card (when viewer is a rep)
//
// The action (`generateCallBriefAction`) handles cache + rate-limit +
// RLS — this component is the UI shell + state management for one
// instance of brief generation.

import { useState, useTransition } from "react";
import {
  generateCallBriefAction,
  type GenerateCallBriefResult,
} from "@/app/(app)/reps/[user_key]/actions";

type ButtonVariant = "secondary"; // future-proof — extend if needed

export default function CallBriefButton({
  repUserKey,
  entityKind,
  entityKey,
  variant: _variant = "secondary",
}: {
  repUserKey: string;
  entityKind: "hcp" | "hco";
  entityKey: string;
  variant?: ButtonVariant;
}) {
  const [briefState, setBriefState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "shown"; bullets: string[] }
    | { kind: "error"; reason: string; message?: string }
  >({ kind: "idle" });
  const [isPending, startTransition] = useTransition();

  function onGenerate() {
    setBriefState({ kind: "loading" });
    startTransition(async () => {
      const res: GenerateCallBriefResult = await generateCallBriefAction({
        repUserKey,
        entityKind,
        entityKey,
      });
      if (res.ok) {
        setBriefState({ kind: "shown", bullets: res.bullets });
      } else {
        setBriefState({
          kind: "error",
          reason: res.reason,
          message: res.message,
        });
      }
    });
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onGenerate}
        disabled={isPending || briefState.kind === "loading"}
        className="inline-flex items-center gap-1.5 text-xs rounded-md px-3 py-1.5 bg-[var(--color-surface)] text-[var(--color-ink)] border border-[var(--color-border)] hover:bg-[var(--color-surface-alt)] disabled:opacity-60"
      >
        {briefState.kind === "loading"
          ? "Generating brief…"
          : briefState.kind === "shown"
            ? "Regenerate brief"
            : "Generate call brief"}
      </button>

      {briefState.kind === "shown" ? (
        <CallBriefRender bullets={briefState.bullets} />
      ) : briefState.kind === "error" ? (
        <CallBriefError reason={briefState.reason} message={briefState.message} />
      ) : null}
    </div>
  );
}

function CallBriefRender({ bullets }: { bullets: string[] }) {
  if (bullets.length === 0) {
    return (
      <p className="text-xs text-[var(--color-ink-muted)] italic px-3 py-2 rounded-md bg-[var(--color-surface)] border border-[var(--color-border)]">
        Not enough signal to generate a useful brief for this entity.
      </p>
    );
  }
  return (
    <div className="rounded-md bg-[var(--color-surface)] border border-[var(--color-border)] px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-[var(--color-ink-muted)] mb-2">
        Pre-call brief
      </p>
      <ul className="space-y-1.5 text-sm text-[var(--color-ink)] list-disc pl-5">
        {bullets.map((b, i) => (
          <li key={i}>{b}</li>
        ))}
      </ul>
    </div>
  );
}

function CallBriefError({
  reason,
  message,
}: {
  reason: string;
  message?: string;
}) {
  const text =
    reason === "rate_limited"
      ? "A brief was generated for this entity recently — try again later."
      : reason === "no_api_key"
        ? "LLM is not configured for this environment."
        : reason === "no_inputs"
          ? "Could not load enough data to generate a brief for this entity."
          : reason === "not_authorized"
            ? "You don't have permission to generate a brief for this rep."
            : message
              ? `Brief generation failed: ${message}`
              : "Brief generation failed.";
  return (
    <p className="text-xs text-[var(--color-negative)] italic px-3 py-2 rounded-md bg-[var(--color-negative)]/5 border border-[var(--color-negative)]/20">
      {text}
    </p>
  );
}
