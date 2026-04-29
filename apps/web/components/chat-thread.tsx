"use client";

import { useState, useTransition, useRef, useEffect } from "react";
import { sendChatMessageAction } from "@/app/(app)/ask/actions";
import type { ChatMessage, ContentBlock } from "@/lib/chat/agent";

// Conversational analytics chat surface for /ask. Stateless on the
// server side — full history posts back with each turn. State lives
// in React useState; refresh = new conversation.
//
// Renders the full Anthropic content-block sequence:
//   - text blocks → markdown prose
//   - tool_use + tool_result blocks → collapsed "🔧 query_X" pills
//     so users can see WHAT data the LLM queried (trust + auditability)

const SUGGESTED_PROMPTS = [
  "Show me the top 10 HCOs by units last quarter",
  "Which accounts are declining in the last 12 weeks?",
  "What's on the watch list?",
  "How is our Tier 1 coverage doing?",
];

export default function ChatThread() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to bottom on new messages.
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, pending]);

  function send(text: string) {
    const trimmed = text.trim();
    if (!trimmed || pending) return;
    setError(null);
    setInput("");
    // Optimistically append the user message so UX feels instant.
    const optimistic: ChatMessage = {
      role: "user",
      content: [{ type: "text", text: trimmed }],
    };
    const historyForServer = messages;
    setMessages((m) => [...m, optimistic]);
    startTransition(async () => {
      const res = await sendChatMessageAction(historyForServer, trimmed);
      if (!res.ok) {
        setError(
          res.reason === "no_api_key"
            ? "ANTHROPIC_API_KEY isn't configured."
            : (res.error ?? "Something went wrong."),
        );
        // Roll back the optimistic user message so the input can be
        // re-tried without duplicating.
        setMessages((m) => m.slice(0, -1));
        setInput(trimmed);
        return;
      }
      setMessages(res.messages);
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    send(input);
  }

  const isEmpty = messages.length === 0;

  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden flex flex-col h-[calc(100vh-12rem)]">
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-5 py-6 space-y-4"
      >
        {isEmpty ? (
          <EmptyState onSelect={(p) => send(p)} />
        ) : (
          messages.map((msg, i) => <MessageBlock key={i} message={msg} />)
        )}
        {pending ? (
          <div className="text-xs text-[var(--color-ink-muted)] italic px-2">
            Thinking…
          </div>
        ) : null}
        {error ? (
          <div className="text-xs text-[var(--color-negative-deep)] px-2">
            Error: {error}
          </div>
        ) : null}
      </div>
      <form
        onSubmit={handleSubmit}
        className="border-t border-[var(--color-border)] p-3 flex gap-2 bg-[var(--color-surface)]"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={pending}
          placeholder="Ask about your data…"
          className="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-ink)] text-sm px-3 py-2 focus:outline-none focus:ring-2 focus:ring-[var(--color-primary)] disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={pending || input.trim().length === 0}
          className="rounded-md bg-[var(--color-primary)] text-white text-sm px-4 py-2 hover:opacity-90 disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </div>
  );
}

function EmptyState({ onSelect }: { onSelect: (p: string) => void }) {
  return (
    <div className="text-center py-8 space-y-4">
      <div className="text-sm text-[var(--color-ink-muted)]">
        Ask questions about your accounts, reps, calls, or sales data.
        Answers come from the same loaders the dashboards use, scoped
        to what you can see.
      </div>
      <div className="flex flex-col items-stretch gap-2 max-w-md mx-auto">
        {SUGGESTED_PROMPTS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onSelect(p)}
            className="text-left text-sm px-3 py-2 rounded-md border border-[var(--color-border)] hover:bg-[var(--color-surface-alt)] text-[var(--color-ink)]"
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

function MessageBlock({ message }: { message: ChatMessage }) {
  // For user messages with simple text, render as a right-aligned
  // bubble. Assistant messages render as left-aligned prose with
  // tool_use/tool_result pills inline.
  const isUser = message.role === "user";
  const onlyText = message.content.every((c) => c.type === "text");

  if (isUser && onlyText) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg bg-[var(--color-primary)] text-white text-sm px-3 py-2">
          {message.content
            .map((c) => (c.type === "text" ? c.text : ""))
            .join("")}
        </div>
      </div>
    );
  }

  // User messages with tool_result blocks (the "results came back"
  // intermediary turn) render as collapsed pills.
  return (
    <div className={"flex " + (isUser ? "justify-end" : "justify-start")}>
      <div className="max-w-[90%] space-y-2">
        {message.content.map((block, i) => (
          <Block key={i} block={block} role={message.role} />
        ))}
      </div>
    </div>
  );
}

function Block({
  block,
  role,
}: {
  block: ContentBlock;
  role: "user" | "assistant";
}) {
  if (block.type === "text") {
    if (role === "user") {
      return (
        <div className="rounded-lg bg-[var(--color-primary)] text-white text-sm px-3 py-2">
          {block.text}
        </div>
      );
    }
    // Plain-text rendering for v1. Prompt instructs the LLM to avoid
    // heavy markdown so prose looks fine without a parser. `whitespace-pre-wrap`
    // preserves the LLM's paragraph breaks.
    return (
      <div className="text-sm text-[var(--color-ink)] leading-relaxed whitespace-pre-wrap">
        {block.text}
      </div>
    );
  }
  if (block.type === "tool_use") {
    return <ToolUsePill toolName={block.name} input={block.input} />;
  }
  // tool_result
  return <ToolResultPill content={block.content} isError={block.is_error} />;
}

function ToolUsePill({
  toolName,
  input,
}: {
  toolName: string;
  input: Record<string, unknown>;
}) {
  const [open, setOpen] = useState(false);
  const summary = Object.entries(input)
    .filter(([_k, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded-md bg-[var(--color-surface-alt)] border border-[var(--color-border)] px-2 py-1 text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
      >
        <span>🔧 {toolName}</span>
        {summary ? <span className="font-mono">({summary})</span> : null}
        <span className="ml-1">{open ? "▼" : "▶"}</span>
      </button>
      {open ? (
        <pre className="mt-1 p-2 bg-[var(--color-surface-alt)] rounded text-[10px] overflow-x-auto">
          {JSON.stringify(input, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}

function ToolResultPill({
  content,
  isError,
}: {
  content: string;
  isError?: boolean;
}) {
  const [open, setOpen] = useState(false);
  let preview = "";
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && "rows" in parsed) {
      const rows = (parsed as { rows?: unknown[] }).rows;
      preview = Array.isArray(rows) ? `${rows.length} row(s)` : "result";
    } else if (parsed && typeof parsed === "object" && "error" in parsed) {
      preview = "error";
    } else {
      preview = "result";
    }
  } catch {
    preview = "result";
  }
  return (
    <div className="text-xs">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={
          "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 hover:opacity-80 " +
          (isError
            ? "bg-[var(--color-negative)]/10 border-[var(--color-negative)]/30 text-[var(--color-negative-deep)]"
            : "bg-[var(--color-surface-alt)] border-[var(--color-border)] text-[var(--color-ink-muted)]")
        }
      >
        <span>{isError ? "✗" : "✓"} {preview}</span>
        <span className="ml-1">{open ? "▼" : "▶"}</span>
      </button>
      {open ? (
        <pre className="mt-1 p-2 bg-[var(--color-surface-alt)] rounded text-[10px] overflow-x-auto max-h-64 overflow-y-auto">
          {(() => {
            try {
              return JSON.stringify(JSON.parse(content), null, 2);
            } catch {
              return content;
            }
          })()}
        </pre>
      ) : null}
    </div>
  );
}
