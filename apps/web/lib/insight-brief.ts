// LLM-generated 2-3 sentence priority brief over the inbox signals. The
// signals themselves are the receipts; the brief is the summary a busy
// brand lead reads first thing in the morning.
//
// Server-only. Never call from a client component.

import Anthropic from "@anthropic-ai/sdk";
import type { SignalGroup } from "@/lib/signals";
import { scopeLabel, type UserScope } from "@/lib/scope";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 300;

export type InsightBrief =
  | { ok: true; brief: string }
  | { ok: false; reason: "no_signals" | "no_api_key" | "llm_error"; error?: string };

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

export async function generateInsightBrief(
  scope: UserScope,
  groups: SignalGroup[],
): Promise<InsightBrief> {
  const totalSignals = groups.reduce((acc, g) => acc + g.signals.length, 0);
  if (totalSignals === 0) return { ok: false, reason: "no_signals" };

  const anthropic = getClient();
  if (!anthropic) return { ok: false, reason: "no_api_key" };

  // Compact representation for the prompt — drop href + rank, keep what
  // matters for narrative.
  const signalDigest = groups
    .filter((g) => g.signals.length > 0)
    .map((g) => ({
      category: g.title,
      description: g.subtitle,
      items: g.signals.map((s) => ({
        severity: s.severity,
        title: s.title,
        detail: s.detail,
      })),
    }));

  const systemPrompt = `You are a commercial analytics assistant for a pharma sales operation. \
The user is reviewing their inbox of automated signals about field activity. \
Your job is to surface the 1-3 most important things to act on this week. \
Be specific — name names from the data. Tie signals together when patterns emerge \
(e.g., a rep whose activity dropped AND has lapsed HCPs is more urgent than either alone). \
Avoid generic advice. Output 2-3 sentences of plain prose. No bullets, no headers, no markdown.`;

  const userPrompt = `User scope: ${scopeLabel(scope)}.\n\nSignals:\n${JSON.stringify(signalDigest, null, 2)}`;

  try {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    });
    const block = res.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") {
      return { ok: false, reason: "llm_error", error: "no text block returned" };
    }
    return { ok: true, brief: block.text.trim() };
  } catch (err) {
    return {
      ok: false,
      reason: "llm_error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
