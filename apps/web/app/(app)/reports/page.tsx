import Link from "next/link";
import { listReports } from "@/lib/powerbi";
import { getCurrentScope } from "@/lib/scope";
import NoAccess from "../dashboard/no-access";

export const dynamic = "force-dynamic";

export default async function ReportsIndex() {
  const { userEmail, resolution } = await getCurrentScope();
  if (!resolution || !resolution.ok) {
    return <NoAccess email={userEmail} reason={resolution?.reason} />;
  }

  const reports = listReports();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-[28px] leading-[1.2] tracking-tight">Reports</h1>
        <p className="text-[var(--color-ink-muted)]">
          Power BI canvases for self-service analysis. Native dashboards live
          on{" "}
          <Link
            href="/dashboard"
            className="text-[var(--color-primary)] hover:underline"
          >
            /dashboard
          </Link>
          .
        </p>
      </div>

      {reports.length === 0 ? (
        <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-12 text-center">
          <p className="font-medium">No reports available yet</p>
          <p className="text-sm text-[var(--color-ink-muted)] mt-2 max-w-md mx-auto">
            Power BI reports haven&apos;t been configured for your tenant. Reach
            out to your admin to add one, or use{" "}
            <Link
              href="/dashboard"
              className="text-[var(--color-primary)] hover:underline"
            >
              /dashboard
            </Link>{" "}
            for native analytics.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {reports.map((r) => (
            <Link
              key={r.id}
              href={`/reports/${encodeURIComponent(r.id)}`}
              className="block rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-5 hover:bg-[var(--color-surface-alt)] transition-colors"
            >
              <p className="font-display text-lg">{r.title}</p>
              <p className="text-sm text-[var(--color-ink-muted)] mt-1">
                {r.description}
              </p>
              <p className="text-xs text-[var(--color-ink-muted)] mt-3 font-mono">
                {r.id}
              </p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
