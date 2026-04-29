import { generateInsightBrief } from "@/lib/insight-brief";
import type { SignalGroup } from "@/lib/signals";
import type { UserScope } from "@/lib/scope";
import { Icon } from "@/components/icon";

// Server component rendered inside <Suspense> so the rest of the inbox
// streams immediately and this card resolves when the LLM call returns.
export default async function InsightBrief({
  scope,
  groups,
}: {
  scope: UserScope;
  groups: SignalGroup[];
}) {
  const result = await generateInsightBrief(scope, groups);
  if (!result.ok) {
    if (result.reason === "no_signals") return null;
    if (result.reason === "no_api_key") {
      return (
        <div className="rounded-lg bg-[var(--color-surface)] border border-dashed border-[var(--color-border)] p-5">
          <p className="text-xs text-[var(--color-ink-muted)]">
            AI brief disabled — set <span className="font-mono">ANTHROPIC_API_KEY</span> in
            .env.local to enable.
          </p>
        </div>
      );
    }
    return (
      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-5">
        <p className="text-xs text-[var(--color-negative-deep)]">
          Couldn&apos;t generate brief: {result.error}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-5">
      <div className="flex items-center gap-1.5 mb-2 text-[var(--color-accent-deep)]">
        <Icon name="sparkles" size={14} />
        <p className="text-xs uppercase tracking-wider">Briefing</p>
      </div>
      <p className="text-sm text-[var(--color-ink)] leading-relaxed">
        {result.brief}
      </p>
    </div>
  );
}

export function InsightBriefLoading() {
  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-5">
      <div className="flex items-center gap-1.5 mb-2 text-[var(--color-accent-deep)]">
        <Icon name="sparkles" size={14} className="animate-pulse" />
        <p className="text-xs uppercase tracking-wider">Briefing</p>
      </div>
      <p className="text-sm text-[var(--color-ink-muted)] italic">
        Reading your signals…
      </p>
    </div>
  );
}
