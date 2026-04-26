// Server-only loaders for /admin/pipelines.

import { and, desc, eq, or, schema } from "@throughline/db";
import { db } from "@/lib/db";

// Recent pipeline runs visible to the current admin: all global runs
// (everyone sees ops health) + tenant-scoped runs for THIS tenant only.
// Capped at 100 rows total; "Load more" / pagination is a future
// iteration when run volume warrants it.
export const PIPELINE_RUNS_LOAD_CAP = 100;

export type PipelineRunRow = {
  id: string;
  scope: "global" | "tenant";
  tenantId: string | null;
  kind:
    | "mapping_propagate"
    | "incremental_refresh"
    | "weekly_full_refresh"
    | "delta_maintenance";
  status: "queued" | "running" | "succeeded" | "failed";
  jobInstanceId: string | null;
  stepMetrics: string | null;
  error: string | null;
  message: string | null;
  triggeredBy: string;
  createdAt: Date;
  finishedAt: Date | null;
};

export async function loadPipelineRuns(
  tenantId: string,
): Promise<PipelineRunRow[]> {
  return db
    .select({
      id: schema.pipelineRun.id,
      scope: schema.pipelineRun.scope,
      tenantId: schema.pipelineRun.tenantId,
      kind: schema.pipelineRun.kind,
      status: schema.pipelineRun.status,
      jobInstanceId: schema.pipelineRun.jobInstanceId,
      stepMetrics: schema.pipelineRun.stepMetrics,
      error: schema.pipelineRun.error,
      message: schema.pipelineRun.message,
      triggeredBy: schema.pipelineRun.triggeredBy,
      createdAt: schema.pipelineRun.createdAt,
      finishedAt: schema.pipelineRun.finishedAt,
    })
    .from(schema.pipelineRun)
    .where(
      or(
        eq(schema.pipelineRun.scope, "global"),
        and(
          eq(schema.pipelineRun.scope, "tenant"),
          eq(schema.pipelineRun.tenantId, tenantId),
        ),
      ),
    )
    .orderBy(desc(schema.pipelineRun.createdAt))
    .limit(PIPELINE_RUNS_LOAD_CAP);
}

// Per-pipeline-kind summary: most recent run + last successful run.
// Drives the top-of-page status tiles on /admin/pipelines.
export type PipelineKindSummary = {
  kind: PipelineRunRow["kind"];
  scope: "global" | "tenant";
  lastRun: PipelineRunRow | null;
  lastSuccess: PipelineRunRow | null;
};

const PIPELINE_KIND_SCOPE: Record<PipelineRunRow["kind"], "global" | "tenant"> = {
  mapping_propagate: "tenant",
  incremental_refresh: "global",
  weekly_full_refresh: "global",
  delta_maintenance: "global",
};

const ALL_KINDS: PipelineRunRow["kind"][] = [
  "incremental_refresh",
  "weekly_full_refresh",
  "delta_maintenance",
  "mapping_propagate",
];

export function summarizePipelineKinds(
  runs: PipelineRunRow[],
): PipelineKindSummary[] {
  // runs are already sorted by createdAt DESC, so the first match per
  // kind is the most recent.
  return ALL_KINDS.map((kind) => {
    const lastRun = runs.find((r) => r.kind === kind) ?? null;
    const lastSuccess =
      runs.find((r) => r.kind === kind && r.status === "succeeded") ?? null;
    return {
      kind,
      scope: PIPELINE_KIND_SCOPE[kind],
      lastRun,
      lastSuccess,
    };
  });
}
