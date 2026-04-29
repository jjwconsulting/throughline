import Link from "next/link";
import { getCurrentScope } from "@/lib/scope";
import NoAccess from "../dashboard/no-access";
import ChatThread from "@/components/chat-thread";

export const dynamic = "force-dynamic";

export default async function AskPage() {
  const { userEmail, resolution } = await getCurrentScope();
  if (!resolution || !resolution.ok) {
    return <NoAccess email={userEmail} reason={resolution?.reason} />;
  }

  return (
    <div className="space-y-4">
      <div>
        <Link
          href="/dashboard"
          className="text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          ← Dashboard
        </Link>
        <h1 className="font-display text-[28px] leading-[1.2] tracking-tight mt-2">Ask</h1>
        <p className="text-[var(--color-ink-muted)]">
          Conversational analytics over your data. The assistant calls
          the same loaders the dashboards use; tool calls are visible
          inline so you can see what was queried. Conversations don&apos;t
          persist — refresh to start over.
        </p>
      </div>
      <ChatThread />
    </div>
  );
}
