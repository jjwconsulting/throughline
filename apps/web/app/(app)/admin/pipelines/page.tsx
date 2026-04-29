import { notFound } from "next/navigation";
import Link from "next/link";
import { getCurrentScope } from "@/lib/scope";
import {
  loadPipelineRuns,
  summarizePipelineKinds,
  type PipelineKindSummary,
  type PipelineRunRow,
} from "./load";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<PipelineRunRow["kind"], string> = {
  incremental_refresh: "Incremental refresh",
  weekly_full_refresh: "Weekly full refresh",
  delta_maintenance: "Delta maintenance",
  mapping_propagate: "Mapping propagate",
};

const KIND_DESCRIPTION: Record<PipelineRunRow["kind"], string> = {
  incremental_refresh:
    "Pulls Veeva incremental updates + new SFTP files, rebuilds silver/gold. Runs on a schedule.",
  weekly_full_refresh:
    "Full Veeva re-pull + complete rebuild. Catches anything incremental missed (deletes, late updates).",
  delta_maintenance:
    "Compacts small files (OPTIMIZE) and removes old file versions (VACUUM) across all gold/silver tables.",
  mapping_propagate:
    "Propagates Veeva mapping changes through silver_account_xref + gold.fact_sale. Triggered from /admin/mappings.",
};

const STATUS_BADGE: Record<PipelineRunRow["status"], string> = {
  queued:
    "bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)] border border-[var(--color-border)]",
  running:
    "bg-[var(--color-primary)]/10 text-[var(--color-primary)] border border-[var(--color-primary)]/30",
  succeeded:
    "bg-[var(--color-positive)]/10 text-[var(--color-positive)] border border-[var(--color-positive)]/30",
  failed:
    "bg-[var(--color-negative)]/10 text-[var(--color-negative)] border border-[var(--color-negative)]/30",
};

function relativeTime(d: Date | null): string {
  if (!d) return "Never";
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? "" : "s"} ago`;
  return d.toISOString().slice(0, 10);
}

function durationLabel(start: Date, end: Date | null): string {
  if (!end) return "—";
  const seconds = Math.round((end.getTime() - start.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  return `${minutes}m ${remSeconds}s`;
}

export default async function PipelinesPage() {
  const { resolution } = await getCurrentScope();
  if (
    !resolution?.ok ||
    (resolution.scope.role !== "admin" && resolution.scope.role !== "bypass")
  ) {
    notFound();
  }
  const tenantId = resolution.scope.tenantId;

  const runs = await loadPipelineRuns(tenantId);
  const summaries = summarizePipelineKinds(runs);

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3 text-xs">
          <Link
            href="/admin/tenants"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            ← Tenants
          </Link>
          <span className="text-[var(--color-ink-muted)]">·</span>
          <Link
            href="/admin/users"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            Users
          </Link>
          <span className="text-[var(--color-ink-muted)]">·</span>
          <Link
            href="/admin/mappings"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            Mappings
          </Link>
          <span className="text-[var(--color-ink-muted)]">·</span>
          <Link
            href="/admin/goals"
            className="text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]"
          >
            Goals
          </Link>
        </div>
        <h1 className="font-display text-3xl mt-2">Pipelines</h1>
        <p className="text-[var(--color-ink-muted)]">
          Health of the data pipelines that keep your dashboards fresh.
          Global pipelines are managed by Throughline ops; tenant-scoped
          pipelines you trigger from the relevant admin pages.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {summaries.map((s) => (
          <PipelineSummaryCard key={s.kind} summary={s} />
        ))}
      </div>

      <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] overflow-hidden">
        <div className="px-5 py-4 border-b border-[var(--color-border)]">
          <h2 className="font-display text-xl">Recent runs</h2>
          <p className="text-xs text-[var(--color-ink-muted)]">
            Last {runs.length} run{runs.length === 1 ? "" : "s"} across all
            pipelines visible to you.
          </p>
        </div>
        {runs.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-[var(--color-ink-muted)] italic">
            No pipeline runs recorded yet. Schedule pipelines in the Fabric
            workspace OR trigger from <Link
              href="/admin/mappings"
              className="text-[var(--color-primary)] hover:underline not-italic"
            >/admin/mappings</Link>.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-[var(--color-surface-alt)] text-[var(--color-ink-muted)] text-xs">
              <tr>
                <th className="text-left px-4 py-2 font-normal">Pipeline</th>
                <th className="text-left px-4 py-2 font-normal">Scope</th>
                <th className="text-left px-4 py-2 font-normal">Status</th>
                <th className="text-left px-4 py-2 font-normal">Started</th>
                <th className="text-left px-4 py-2 font-normal">Duration</th>
                <th className="text-left px-4 py-2 font-normal">By</th>
                <th className="text-left px-4 py-2 font-normal">Detail</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-[var(--color-border)] align-top"
                >
                  <td className="px-4 py-2">{KIND_LABEL[r.kind]}</td>
                  <td className="px-4 py-2 text-[var(--color-ink-muted)] text-xs">
                    {r.scope}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`text-xs rounded px-2 py-0.5 ${STATUS_BADGE[r.status]}`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-[var(--color-ink-muted)] text-xs">
                    {relativeTime(r.createdAt)}
                  </td>
                  <td className="px-4 py-2 text-[var(--color-ink-muted)] text-xs font-mono">
                    {durationLabel(r.createdAt, r.finishedAt)}
                  </td>
                  <td className="px-4 py-2 text-[var(--color-ink-muted)] text-xs font-mono">
                    {r.triggeredBy}
                  </td>
                  <td className="px-4 py-2 text-[var(--color-ink-muted)] text-xs max-w-md">
                    {r.error ? (
                      <details>
                        <summary className="cursor-pointer text-[var(--color-negative)]">
                          {r.message ?? "Failed"}
                        </summary>
                        <pre className="mt-1 whitespace-pre-wrap text-[10px] bg-[var(--color-surface-alt)] p-2 rounded">
                          {r.error.slice(0, 2000)}
                        </pre>
                      </details>
                    ) : r.stepMetrics ? (
                      <details>
                        <summary className="cursor-pointer">
                          {r.message ?? "Details"}
                        </summary>
                        <pre className="mt-1 whitespace-pre-wrap text-[10px] bg-[var(--color-surface-alt)] p-2 rounded">
                          {(() => {
                            try {
                              return JSON.stringify(
                                JSON.parse(r.stepMetrics),
                                null,
                                2,
                              );
                            } catch {
                              return r.stepMetrics;
                            }
                          })()}
                        </pre>
                      </details>
                    ) : (
                      r.message ?? "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function PipelineSummaryCard({ summary }: { summary: PipelineKindSummary }) {
  const { kind, scope, lastRun, lastSuccess } = summary;
  return (
    <div className="rounded-lg bg-[var(--color-surface)] border border-[var(--color-border)] p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-base">{KIND_LABEL[kind]}</h3>
          <p className="text-xs text-[var(--color-ink-muted)] mt-1">
            {KIND_DESCRIPTION[kind]}
          </p>
        </div>
        <span className="text-[10px] uppercase tracking-wide text-[var(--color-ink-muted)] whitespace-nowrap">
          {scope}
        </span>
      </div>
      <div className="mt-3 space-y-1 text-xs text-[var(--color-ink-muted)]">
        <div>
          <span className="font-medium">Last run:</span>{" "}
          {lastRun ? (
            <>
              {relativeTime(lastRun.createdAt)} ·{" "}
              <span
                className={
                  "rounded px-1.5 py-0.5 text-[10px] " +
                  STATUS_BADGE[lastRun.status]
                }
              >
                {lastRun.status}
              </span>
            </>
          ) : (
            "—"
          )}
        </div>
        <div>
          <span className="font-medium">Last success:</span>{" "}
          {lastSuccess ? relativeTime(lastSuccess.createdAt) : "—"}
        </div>
      </div>
      {scope === "tenant" ? (
        <p className="text-[10px] text-[var(--color-ink-muted)] mt-3">
          Trigger from{" "}
          <Link
            href="/admin/mappings"
            className="text-[var(--color-primary)] hover:underline"
          >
            /admin/mappings
          </Link>
          .
        </p>
      ) : (
        <p className="text-[10px] text-[var(--color-ink-muted)] mt-3">
          Managed by Throughline ops. Schedule in Fabric workspace.
        </p>
      )}
    </div>
  );
}
