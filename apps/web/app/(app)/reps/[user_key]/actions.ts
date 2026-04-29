"use server";

// Server actions for the /reps/[user_key] action launchpad.
// Currently: generateCallBrief — on-demand LLM-generated pre-call brief
// for a specific HCP/HCO. Cache + rate-limit in lib/call-brief.ts.
//
// RLS: actions verify the caller can see the requested rep before
// gathering inputs. A rep cannot generate a brief for someone else's
// territory; managers + admins are scoped per usual.

import { getCurrentScope, canSeeRep } from "@/lib/scope";
import { loadCallBrief, type CallBriefResult } from "@/lib/call-brief";

export type GenerateCallBriefResult =
  | { ok: true; bullets: string[]; generatedAt: string }
  | { ok: false; reason: string; message?: string };

export async function generateCallBriefAction(args: {
  repUserKey: string;
  entityKind: "hcp" | "hco";
  entityKey: string;
}): Promise<GenerateCallBriefResult> {
  const { resolution } = await getCurrentScope();
  if (!resolution || !resolution.ok) {
    return { ok: false, reason: "not_authorized" };
  }
  const { scope } = resolution;
  if (!canSeeRep(scope, args.repUserKey)) {
    return { ok: false, reason: "not_authorized" };
  }

  const result: CallBriefResult = await loadCallBrief({
    tenantId: scope.tenantId,
    repUserKey: args.repUserKey,
    entityKind: args.entityKind,
    entityKey: args.entityKey,
    generateOnMiss: true,
  });

  if (result.kind === "error") {
    return { ok: false, reason: result.reason, message: result.message };
  }
  return {
    ok: true,
    bullets: result.brief.bullets,
    generatedAt: result.generatedAt.toISOString(),
  };
}
