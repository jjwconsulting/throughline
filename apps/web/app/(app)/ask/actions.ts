"use server";

import { getCurrentScope, scopeToSql } from "@/lib/scope";
import {
  runChatTurn,
  type ChatMessage,
  type ChatTurnResult,
} from "@/lib/chat/agent";

// One full chat turn: user sends a message, runChatTurn loops the
// LLM ↔ tools cycle, returns the updated conversation. Client is
// stateless on the server side — full history travels in each
// request, no DB persistence in v1.

export async function sendChatMessageAction(
  history: ChatMessage[],
  userMessage: string,
): Promise<ChatTurnResult> {
  const { resolution } = await getCurrentScope();
  if (!resolution || !resolution.ok) {
    return {
      ok: false,
      reason: "llm_error",
      error: "Not authorized — sign in first.",
    };
  }
  const { scope } = resolution;
  return runChatTurn({
    history,
    userMessage,
    userScope: scope,
    sqlScope: scopeToSql(scope),
    tenantId: scope.tenantId,
  });
}
