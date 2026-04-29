import { Suspense } from "react";
import { getCurrentScope, scopeToSql } from "@/lib/scope";
import { loadAllSignals } from "@/lib/signals";
import SignalsPanel from "@/components/signals-panel";
import NoAccess from "../dashboard/no-access";
import InsightBrief, { InsightBriefLoading } from "./insight-brief";

export const dynamic = "force-dynamic";

export default async function Inbox() {
  const { userEmail, resolution } = await getCurrentScope();
  if (!resolution || !resolution.ok) {
    return <NoAccess email={userEmail} reason={resolution?.reason} />;
  }
  const { scope } = resolution;
  const sqlScope = scopeToSql(scope);

  const groups = await loadAllSignals(scope.tenantId, scope, sqlScope);
  const totalSignals = groups.reduce((acc, g) => acc + g.signals.length, 0);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-[28px] leading-[1.2] tracking-tight">Inbox</h1>
        <p className="text-[var(--color-ink-muted)]">
          Signals across your scope.{" "}
          {totalSignals > 0
            ? `${totalSignals} item${totalSignals === 1 ? "" : "s"} need attention.`
            : "All clear right now."}
        </p>
      </div>

      {totalSignals > 0 ? (
        <Suspense fallback={<InsightBriefLoading />}>
          <InsightBrief scope={scope} groups={groups} />
        </Suspense>
      ) : null}

      <div className="space-y-4">
        {groups.map((g) => (
          <SignalsPanel
            key={g.key}
            title={g.title}
            subtitle={g.subtitle}
            signals={g.signals}
            emptyHint="Nothing in this category."
          />
        ))}
      </div>
    </div>
  );
}
