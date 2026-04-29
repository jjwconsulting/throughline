import { notFound } from "next/navigation";
import Link from "next/link";
import { getReportEmbedConfig, listReports } from "@/lib/powerbi";
import { getCurrentScope } from "@/lib/scope";
import EmbedLoader from "../../dashboard/embed-loader";
import NoAccess from "../../dashboard/no-access";

export const dynamic = "force-dynamic";

type RouteParams = Promise<{ id: string }>;

export default async function ReportDetail({ params }: { params: RouteParams }) {
  const { id } = await params;

  const { userEmail, resolution } = await getCurrentScope();
  if (!resolution || !resolution.ok) {
    return <NoAccess email={userEmail} reason={resolution?.reason} />;
  }
  const { scope } = resolution;

  // Allowlist: only known report ids can be embedded. Prevents URL-tampering
  // from minting tokens against arbitrary reports the SP has access to.
  const allowed = listReports();
  const report = allowed.find((r) => r.id === id);
  if (!report) notFound();

  let embed;
  try {
    embed = await getReportEmbedConfig(scope.tenantId, id);
  } catch (err) {
    return (
      <div className="space-y-4">
        <Link
          href="/reports"
          className="text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          ← Reports
        </Link>
        <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-6">
          <p className="text-sm font-medium">Report unavailable</p>
          <p className="text-xs text-[var(--color-ink-muted)] mt-1 font-mono break-all">
            {err instanceof Error ? err.message : String(err)}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <Link
          href="/reports"
          className="text-xs text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
        >
          ← Reports
        </Link>
        <h1 className="font-display text-[28px] leading-[1.2] tracking-tight mt-2">{report.title}</h1>
        <p className="text-[var(--color-ink-muted)] text-sm">
          {report.description}
        </p>
      </div>

      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
        <EmbedLoader
          reportId={embed.reportId}
          embedUrl={embed.embedUrl}
          embedToken={embed.embedToken}
        />
      </div>
    </div>
  );
}
