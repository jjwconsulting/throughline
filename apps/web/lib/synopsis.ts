// Dashboard synopsis: LLM-generated "since you last logged in" summary
// of what materially changed in the user's data since the last successful
// pipeline_run. Cached per (tenant, user, pipeline_run_id) so the LLM
// only fires once per user per data refresh — repeated /dashboard loads
// are free.
//
// Lifecycle:
//   1. Find latest succeeded pipeline_run for the tenant.
//   2. If user dismissed AFTER that run finished → hide card (already
//      seen this refresh's synopsis).
//   3. Cache lookup by (tenant, user, run_id) → return body if found.
//   4. Cache miss → gather inputs (rising/declining/watch/signals via
//      existing loaders), bail with "no_changes" if everything's empty,
//      otherwise build prompt + call Claude + cache result.
//
// Server-only. Never call from a client component.

import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq, schema } from "@throughline/db";
import { db } from "@/lib/db";
import {
  loadAccountMotion,
  loadWatchListAccounts,
} from "@/lib/sales";
import { loadAllSignals } from "@/lib/signals";
import { type Scope } from "@/lib/interactions";
import { type UserScope, scopeLabel } from "@/lib/scope";
import { DEFAULT_FILTERS } from "@/app/(app)/dashboard/filters";

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 400;

// Minimum gap between synopsis GENERATIONS for a single user. Cache
// hits within the same pipeline_run aren't affected (they cost
// nothing); this only kicks in when a new pipeline_run lands and
// would otherwise trigger a fresh LLM call. In dev (1 run/day) it
// rarely matters; in prod with 30-60 min refresh cadence this caps
// the user-visible churn at "at most one new synopsis per N hours."
//
// FOLLOW-UP: tune per real prod cadence + customer feedback. Could
// promote to per-tenant config (some customers may want hourly,
// others daily). See docs/product/llm-expansion.md "Synopsis tuning"
// for the rationale.
const MIN_HOURS_BETWEEN_GENERATIONS = 4;

export type SynopsisResult =
  | {
      kind: "show";
      body: string;
      pipelineRunId: string;
      generatedAt: Date;
    }
  | {
      kind: "hide";
      reason:
        | "no_run"
        | "dismissed"
        | "no_changes"
        | "no_api_key"
        | "llm_error"
        | "rate_limited";
      error?: string;
    };

export async function loadDashboardSynopsis(args: {
  userScope: UserScope;
  // Accept nullable to match getCurrentScope's return shape — bail
  // gracefully when missing (shouldn't happen post-auth but no point
  // crashing the dashboard if it does).
  userEmail: string | null;
  sqlScope: Scope;
}): Promise<SynopsisResult> {
  const { userScope, userEmail, sqlScope } = args;
  if (!userEmail) return { kind: "hide", reason: "no_run" };

  // 1. Latest successful pipeline_run for the tenant. Synopsis "data
  //    snapshot" is anchored on this run; cache key includes its id.
  const latestRunRows = await db
    .select({
      id: schema.pipelineRun.id,
      finishedAt: schema.pipelineRun.finishedAt,
    })
    .from(schema.pipelineRun)
    .where(
      and(
        eq(schema.pipelineRun.tenantId, userScope.tenantId),
        eq(schema.pipelineRun.status, "succeeded"),
      ),
    )
    .orderBy(desc(schema.pipelineRun.finishedAt))
    .limit(1);
  const run = latestRunRows[0];
  if (!run || !run.finishedAt) {
    return { kind: "hide", reason: "no_run" };
  }

  // 2. Did the user dismiss AFTER this run finished? If so, they've
  //    seen and dismissed this data refresh's synopsis — hide.
  const tuRows = await db
    .select({
      lastDismissed: schema.tenantUser.lastDismissedSynopsisAt,
    })
    .from(schema.tenantUser)
    .where(
      and(
        eq(schema.tenantUser.tenantId, userScope.tenantId),
        eq(schema.tenantUser.userEmail, userEmail),
      ),
    )
    .limit(1);
  const lastDismissed = tuRows[0]?.lastDismissed;
  if (lastDismissed && lastDismissed >= run.finishedAt) {
    return { kind: "hide", reason: "dismissed" };
  }

  // 3. Cache lookup. The (tenant, user, run_id) tuple uniquely
  //    identifies "this user's synopsis for this data snapshot."
  const cachedRows = await db
    .select({
      body: schema.synopsisCache.body,
      generatedAt: schema.synopsisCache.generatedAt,
    })
    .from(schema.synopsisCache)
    .where(
      and(
        eq(schema.synopsisCache.tenantId, userScope.tenantId),
        eq(schema.synopsisCache.userEmail, userEmail),
        eq(schema.synopsisCache.pipelineRunId, run.id),
      ),
    )
    .limit(1);
  const cached = cachedRows[0];
  if (cached) {
    return {
      kind: "show",
      body: cached.body,
      pipelineRunId: run.id,
      generatedAt: cached.generatedAt,
    };
  }

  // 4. Rate-limit gate. A new pipeline_run could land 30 min after
  //    the previous one in prod; without this gate the user would see
  //    a fresh synopsis every refresh. Look at the most recent
  //    cached synopsis (across ALL runs) for this user — if it was
  //    generated < MIN_HOURS_BETWEEN_GENERATIONS hours ago, suppress
  //    instead of regenerating. Cache hits are unaffected (they cost
  //    nothing and represent a stable "current refresh" view).
  const recentCacheRows = await db
    .select({
      generatedAt: schema.synopsisCache.generatedAt,
    })
    .from(schema.synopsisCache)
    .where(
      and(
        eq(schema.synopsisCache.tenantId, userScope.tenantId),
        eq(schema.synopsisCache.userEmail, userEmail),
      ),
    )
    .orderBy(desc(schema.synopsisCache.generatedAt))
    .limit(1);
  const mostRecentGeneration = recentCacheRows[0]?.generatedAt;
  if (mostRecentGeneration) {
    const hoursSince =
      (Date.now() - new Date(mostRecentGeneration).getTime()) /
      (1000 * 60 * 60);
    if (hoursSince < MIN_HOURS_BETWEEN_GENERATIONS) {
      return { kind: "hide", reason: "rate_limited" };
    }
  }

  // 5. Gather "what changed" inputs. 12-week window with period-
  //    over-period comparison gives a reasonable "what's been moving
  //    lately" picture (matches the dashboard default).
  const filters = { ...DEFAULT_FILTERS, range: "12w" as const };
  const [rising, declining, watch, signalGroups] = await Promise.all([
    loadAccountMotion(userScope.tenantId, filters, "rising", 5, sqlScope),
    loadAccountMotion(userScope.tenantId, filters, "declining", 5, sqlScope),
    loadWatchListAccounts(userScope.tenantId, filters, 5, sqlScope),
    loadAllSignals(userScope.tenantId, userScope, sqlScope),
  ]);

  // Top 5 signals across all groups, severity-sorted.
  const topSignals = signalGroups
    .flatMap((g) => g.signals.map((s) => ({ ...s, category: g.title })))
    .sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity))
    .slice(0, 5);

  // Empty-input short-circuit. No point burning an LLM call to say
  // "nothing happened" — render no card at all (per design decision in
  // docs/product/llm-expansion.md).
  const hasData =
    rising.length > 0 ||
    declining.length > 0 ||
    watch.length > 0 ||
    topSignals.length > 0;
  if (!hasData) {
    return { kind: "hide", reason: "no_changes" };
  }

  const anthropic = getClient();
  if (!anthropic) return { kind: "hide", reason: "no_api_key" };

  // Compact prompt input — names + numbers, no metadata noise. The
  // prompt instructions emphasize "names + numbers ONLY from this input"
  // to prevent hallucination.
  const inputs = {
    period: "Last 12 weeks vs the prior 12 weeks",
    rising_accounts: rising.map((r) => ({
      name: r.name,
      location: [r.city, r.state].filter(Boolean).join(", ") || null,
      current_units: Math.round(r.units_period),
      prior_units: Math.round(r.units_prior),
      delta_units: Math.round(r.units_delta),
      delta_pct: r.units_delta_pct == null ? null : Math.round(r.units_delta_pct),
    })),
    declining_accounts: declining.map((r) => ({
      name: r.name,
      location: [r.city, r.state].filter(Boolean).join(", ") || null,
      current_units: Math.round(r.units_period),
      prior_units: Math.round(r.units_prior),
      delta_units: Math.round(r.units_delta),
      delta_pct: r.units_delta_pct == null ? null : Math.round(r.units_delta_pct),
    })),
    watch_list: watch.map((w) => ({
      name: w.name,
      location: [w.city, w.state].filter(Boolean).join(", ") || null,
      prior_units: Math.round(w.units_prior),
      last_sale_date: w.last_sale_date,
      current_rep: w.current_rep_name,
    })),
    signals: topSignals.map((s) => ({
      severity: s.severity,
      category: s.category,
      title: s.title,
      detail: s.detail,
    })),
  };

  const inputJson = JSON.stringify(inputs, null, 2);

  try {
    const res = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `User scope: ${scopeLabel(userScope)}.\n\nWhat changed since the last data refresh:\n${inputJson}`,
        },
      ],
    });
    const block = res.content.find((b) => b.type === "text");
    if (!block || block.type !== "text") {
      return {
        kind: "hide",
        reason: "llm_error",
        error: "no text block returned",
      };
    }
    const body = block.text.trim();

    // Persist to cache. ON CONFLICT update so concurrent loads on a
    // fresh refresh don't cause duplicate-key errors (race: both
    // load, both compute, both write — last write wins, fine since
    // bodies should be near-identical).
    await db
      .insert(schema.synopsisCache)
      .values({
        tenantId: userScope.tenantId,
        userEmail,
        pipelineRunId: run.id,
        body,
        inputSnapshot: inputJson,
      })
      .onConflictDoUpdate({
        target: [
          schema.synopsisCache.tenantId,
          schema.synopsisCache.userEmail,
          schema.synopsisCache.pipelineRunId,
        ],
        set: { body, inputSnapshot: inputJson, generatedAt: new Date() },
      });

    return {
      kind: "show",
      body,
      pipelineRunId: run.id,
      generatedAt: new Date(),
    };
  } catch (err) {
    return {
      kind: "hide",
      reason: "llm_error",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const SYSTEM_PROMPT = `You are a commercial analytics assistant for a pharma sales operation. \
The user just opened their dashboard. Your job is to summarize what materially changed since their \
last data refresh — top movers, dropped customers, urgent signals — in 3-4 sentences of plain prose.

Hard rules:
- Use ONLY names and numbers from the input. Never invent a fact, account, rep, or number.
- Lead with the most consequential single item. Tie related items together when patterns emerge \
(e.g., "Memorial Hospital dropped 40% AND landed on the watch list — likely needs a touchpoint").
- Be specific: account names, units, percentages, rep names. No vague "some accounts trended down."
- End with one concrete action ("Worth a call to..." / "Check..." / "Have the rep follow up on...").
- If the input is mostly low-magnitude noise, say so concisely instead of forcing drama.
- No bullets, no markdown, no headers, no preamble ("Here's a summary:" etc). Just the prose.`;

function severityOrder(s: string): number {
  if (s === "alert") return 0;
  if (s === "warning") return 1;
  return 2;
}

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}
