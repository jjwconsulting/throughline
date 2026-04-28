// Chat agent for /ask. Orchestrates LLM ↔ tools loop:
//   1. Send user message + conversation history + tools list to Claude
//   2. If Claude responds with tool_use blocks, execute each tool and
//      append tool_result blocks to the conversation
//   3. Send updated conversation back to Claude
//   4. Loop until Claude returns a stop_reason of 'end_turn' (text-only
//      response — the final answer)
//
// Hard cap on loop iterations to prevent runaway tool chains (defensive).
//
// Conversation messages are returned to the caller in a serializable
// shape so the chat UI can render the full thread including the
// intermediate tool calls (collapsed by default in the UI).

import Anthropic from "@anthropic-ai/sdk";
import { TOOL_BY_NAME, toolsForApi, type ToolHandlerCtx } from "@/lib/chat/tools";
import { type UserScope, scopeLabel } from "@/lib/scope";
import { type Scope } from "@/lib/interactions";

const MODEL = "claude-opus-4-7";
const MAX_TOKENS = 1500;
const MAX_TOOL_LOOPS = 8;

// Wire-format messages exchanged with the client. Keeps the Anthropic
// content-block shape since we want to render tool calls inline.
export type ChatMessage = {
  role: "user" | "assistant";
  // Anthropic's content-block array. We render text blocks as prose,
  // tool_use blocks as collapsed "🔧 query_top_accounts(metric=units…)"
  // pills, and tool_result blocks similarly (typically alongside the
  // tool_use that produced them).
  content: ContentBlock[];
};

export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

export type ChatTurnResult =
  | { ok: true; messages: ChatMessage[] }
  | { ok: false; reason: "no_api_key" | "llm_error"; error?: string };

const SYSTEM_PROMPT = `You are a commercial analytics assistant for a pharma sales operation, embedded in the Throughline app.

You have access to tools that query the user's data — call them to answer questions. NEVER invent numbers, account names, rep names, or other facts. If a tool returns no data, say so honestly.

Style:
- Concise, direct, professional. Short sentences, no fluff.
- When you cite a number, say where it came from ("based on the top 10 HCOs by units in the last 12 weeks").
- PLAIN PROSE ONLY. No markdown tables, no headers, no bullet lists with markdown syntax. Use newlines + numbered prose if listing 3+ items ("1. Memorial Hospital — 234 units...\n2. ..."). The chat UI doesn't render markdown.
- If a tool result includes a 'scope' field, briefly mention what scope the user is seeing ("for your team", "tenant-wide", etc.) when relevant.

When to call tools:
- Default to calling a tool when the user asks for any specific data. Don't guess from memory.
- Chain tools when needed (e.g., lookup_entity to find an HCO key, then query_account_motion).
- Stop calling tools and answer once you have enough to respond.

When you're unsure what the user means:
- Ask one clarifying question. Don't guess.
- Suggest 2-3 example questions in the empty state — common pharma analytics shapes.

Limitations to be honest about:
- You only see what the loaders return. If a question is outside the available tools, say so.
- Tool results may be empty if filters / scope return nothing — say "no matches" instead of inventing.`;

export async function runChatTurn(args: {
  history: ChatMessage[];
  userMessage: string;
  userScope: UserScope;
  sqlScope: Scope;
  tenantId: string;
}): Promise<ChatTurnResult> {
  const { history, userMessage, userScope, sqlScope, tenantId } = args;

  const anthropic = getClient();
  if (!anthropic) return { ok: false, reason: "no_api_key" };

  const ctx: ToolHandlerCtx = { tenantId, userScope, sqlScope };

  // Build the working conversation: prior history + new user message.
  const conversation: ChatMessage[] = [
    ...history,
    { role: "user", content: [{ type: "text", text: userMessage }] },
  ];

  // System prompt gets the user's scope so the LLM can mention it
  // appropriately ("you're looking at your team's calls", etc.).
  const systemWithScope = `${SYSTEM_PROMPT}\n\nCurrent user scope: ${scopeLabel(userScope)}.`;

  for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
    let res;
    try {
      res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: systemWithScope,
        tools: toolsForApi(),
        messages: conversation.map(
          (m): { role: "user" | "assistant"; content: ContentBlock[] } => ({
            role: m.role,
            content: m.content,
          }),
        ),
      });
    } catch (err) {
      return {
        ok: false,
        reason: "llm_error",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Append the assistant's response to the conversation. SDK content
    // blocks already match our ContentBlock shape (modulo any block
    // types we don't handle yet — filter to known ones).
    const assistantBlocks: ContentBlock[] = [];
    const toolUses: {
      id: string;
      name: string;
      input: Record<string, unknown>;
    }[] = [];
    for (const block of res.content) {
      if (block.type === "text") {
        assistantBlocks.push({ type: "text", text: block.text });
      } else if (block.type === "tool_use") {
        const tu = {
          id: block.id,
          name: block.name,
          input: (block.input ?? {}) as Record<string, unknown>,
        };
        assistantBlocks.push({ type: "tool_use", ...tu });
        toolUses.push(tu);
      }
      // Other block types (thinking, etc.) ignored for v1.
    }
    conversation.push({ role: "assistant", content: assistantBlocks });

    // If the model is done, return the full conversation.
    if (res.stop_reason === "end_turn" && toolUses.length === 0) {
      return { ok: true, messages: conversation };
    }

    // Execute tool calls in parallel and append a single user message
    // containing all tool_result blocks.
    if (toolUses.length === 0) {
      // Stopped for some other reason (max_tokens, etc.) — return what
      // we have rather than loop forever.
      return { ok: true, messages: conversation };
    }

    const results = await Promise.all(
      toolUses.map(async (tu) => {
        const tool = TOOL_BY_NAME.get(tu.name);
        if (!tool) {
          return {
            type: "tool_result" as const,
            tool_use_id: tu.id,
            content: JSON.stringify({
              error: `Unknown tool: ${tu.name}`,
            }),
            is_error: true,
          };
        }
        try {
          const out = await tool.handler(tu.input, ctx);
          return {
            type: "tool_result" as const,
            tool_use_id: tu.id,
            content: JSON.stringify(out),
          };
        } catch (err) {
          return {
            type: "tool_result" as const,
            tool_use_id: tu.id,
            content: JSON.stringify({
              error: err instanceof Error ? err.message : String(err),
            }),
            is_error: true,
          };
        }
      }),
    );
    conversation.push({ role: "user", content: results });
    // Loop continues — model gets the tool results and produces
    // either a final text answer or more tool calls.
  }

  // Hit the loop cap. Return what we have with a warning text block.
  conversation.push({
    role: "assistant",
    content: [
      {
        type: "text",
        text:
          "(I had to stop after several tool calls — the conversation may be incomplete. " +
          "Try asking a more specific question.)",
      },
    ],
  });
  return { ok: true, messages: conversation };
}

let client: Anthropic | null = null;
function getClient(): Anthropic | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (!client) {
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}
