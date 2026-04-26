"use server";

import { revalidatePath } from "next/cache";
import { and, desc, eq, schema } from "@throughline/db";
import { db } from "@/lib/db";
import { queryFabric } from "@/lib/fabric";
import { triggerNotebookRun } from "@/lib/fabric-jobs";
import { getCurrentScope } from "@/lib/scope";

// ---------------------------------------------------------------------------
// Search Veeva accounts (HCP + HCO) for the mapping picker.
// Server action callable from the client picker component.
// ---------------------------------------------------------------------------

export type VeevaAccountMatch = {
  veeva_account_id: string;
  account_type: "HCP" | "HCO";
  name: string;
  city: string | null;
  state: string | null;
  // npi for HCP, hco_type for HCO — admin uses to disambiguate
  detail: string | null;
};

export async function searchVeevaAccountsAction(
  query: string,
  accountType: "ALL" | "HCP" | "HCO" = "ALL",
): Promise<VeevaAccountMatch[]> {
  const { resolution } = await getCurrentScope();
  if (
    !resolution?.ok ||
    (resolution.scope.role !== "admin" && resolution.scope.role !== "bypass")
  ) {
    return [];
  }
  const tenantId = resolution.scope.tenantId;
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  // LIKE search on name. Same pattern would benefit from full-text index
  // when row counts get serious (>1M); fennec dim_hcp at 78k is fine.
  const wildcardQuery = `%${trimmed}%`;

  const includeHcp = accountType === "ALL" || accountType === "HCP";
  const includeHco = accountType === "ALL" || accountType === "HCO";

  const promises: Promise<VeevaAccountMatch[]>[] = [];

  if (includeHcp) {
    promises.push(
      queryFabric<VeevaAccountMatch>(
        tenantId,
        `SELECT TOP 25
           veeva_account_id, 'HCP' AS account_type, name,
           city, state, npi AS detail
         FROM gold.dim_hcp
         WHERE tenant_id = @tenantId AND name LIKE @q
         ORDER BY name`,
        { q: wildcardQuery },
      ),
    );
  }
  if (includeHco) {
    promises.push(
      queryFabric<VeevaAccountMatch>(
        tenantId,
        `SELECT TOP 25
           veeva_account_id, 'HCO' AS account_type, name,
           city, state, hco_type AS detail
         FROM gold.dim_hco
         WHERE tenant_id = @tenantId AND name LIKE @q
         ORDER BY name`,
        { q: wildcardQuery },
      ),
    );
  }

  const results = (await Promise.all(promises)).flat();
  // Sort combined results so the matches feel natural (alpha by name).
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results.slice(0, 50);
}

// ---------------------------------------------------------------------------
// Save (or update) an account_xref mapping.
// Writes to Postgres `mapping` table with kind='account_xref'.
// ---------------------------------------------------------------------------

export type SaveMappingState = {
  error: string | null;
  success: string | null;
};

export async function saveAccountMappingAction(
  _prev: SaveMappingState,
  formData: FormData,
): Promise<SaveMappingState> {
  const { resolution } = await getCurrentScope();
  if (
    !resolution?.ok ||
    (resolution.scope.role !== "admin" && resolution.scope.role !== "bypass")
  ) {
    return { error: "Not authorized", success: null };
  }
  const tenantId = resolution.scope.tenantId;

  const distributorAccountId = String(
    formData.get("distributor_account_id") ?? "",
  ).trim();
  const veevaAccountId = String(formData.get("veeva_account_id") ?? "").trim();
  const distributorAccountName = String(
    formData.get("distributor_account_name") ?? "",
  ).trim();
  const veevaAccountName = String(formData.get("veeva_account_name") ?? "").trim();
  const notesInput = String(formData.get("notes") ?? "").trim();

  if (!distributorAccountId || !veevaAccountId) {
    return { error: "Missing required ids", success: null };
  }

  const notes =
    notesInput ||
    `${distributorAccountName} → ${veevaAccountName}`;
  const createdBy = resolution.scope.role;

  // Upsert: one mapping per (tenant, kind, source_key). Re-saving updates
  // the target. Use `mapping` table — kind='account_xref' already in the
  // mappingKindEnum.
  //
  // Drizzle schema doesn't define a unique constraint on
  // (tenant_id, kind, source_key) currently — defensive: query first, then
  // either insert or update.
  const existing = await db
    .select({ id: schema.mapping.id })
    .from(schema.mapping)
    .where(
      and(
        eq(schema.mapping.tenantId, tenantId),
        eq(schema.mapping.kind, "account_xref"),
        eq(schema.mapping.sourceKey, distributorAccountId),
      ),
    )
    .limit(1);

  try {
    if (existing[0]) {
      await db
        .update(schema.mapping)
        .set({
          targetValue: veevaAccountId,
          notes,
          updatedBy: createdBy,
          updatedAt: new Date(),
        })
        .where(eq(schema.mapping.id, existing[0].id));
    } else {
      await db.insert(schema.mapping).values({
        tenantId,
        kind: "account_xref",
        sourceKey: distributorAccountId,
        targetValue: veevaAccountId,
        notes,
        effectiveFrom: new Date(),
        updatedBy: createdBy,
      });
    }
  } catch (err) {
    return {
      error: `DB error: ${err instanceof Error ? err.message : String(err)}`,
      success: null,
    };
  }

  revalidatePath("/admin/mappings");
  return {
    error: null,
    success: `Mapped ${distributorAccountName || distributorAccountId}`,
  };
}

// ---------------------------------------------------------------------------
// CSV upload action — bulk account_xref mappings.
//
// Two header shapes supported:
//   1. Default template — distributor_account_id, distributor_account_name,
//      veeva_account_id (case-insensitive).
//   2. Arbitrary file — when the client uploader provides explicit column
//      overrides via FormData fields (col_distributor_account_id,
//      col_distributor_account_name, col_veeva_account_id), those header
//      names are looked up in the file instead. Lets transitioning clients
//      drop in their existing mapping files without reformatting.
//
// Per-row validation: veeva_account_id must exist in dim_hcp ∪ dim_hco.
// Distributor IDs aren't constrained to currently-unmapped — admin can
// pre-load mappings for IDs not yet seen in fact_sale (matches the goals
// CSV pattern: bulk for day-1 setup).
// ---------------------------------------------------------------------------

// Field labels for the resolution-source breakdown surfaced in the UI.
// Order matters: same as the resolution priority below.
const RESOLUTION_FIELD_LABELS = {
  veeva_account_id: "Veeva CRM Account ID",
  network_id: "Veeva Network ID",
  npi: "NPI",
  dea_number: "DEA #",
  aha_id: "AHA ID",
} as const;

type ResolutionField = keyof typeof RESOLUTION_FIELD_LABELS;

export type UploadMappingsState = {
  saved: number;
  // Rows with one ID present but not the other — typically "Veeva master
  // list" rows in the client's file that don't yet have a distributor side
  // (or template rows the admin hasn't filled in). Not errors, but worth
  // surfacing as a count so the admin knows how many rows weren't
  // actionable.
  skipped: number;
  rowResults: { line: number; status: "ok" | "error"; message: string }[];
  // Per-field count of how many rows resolved via each candidate ID
  // column. Tells the admin "your file uses Network ID by convention" at
  // a glance — implicit configuration without a separate setting.
  resolutionBreakdown?: { field: ResolutionField; label: string; count: number }[];
};

export async function uploadMappingsAction(
  _prev: UploadMappingsState,
  formData: FormData,
): Promise<UploadMappingsState> {
  const empty: UploadMappingsState = { saved: 0, skipped: 0, rowResults: [] };

  const { resolution } = await getCurrentScope();
  if (
    !resolution?.ok ||
    (resolution.scope.role !== "admin" && resolution.scope.role !== "bypass")
  ) {
    return {
      ...empty,
      rowResults: [{ line: 0, status: "error", message: "Not authorized" }],
    };
  }
  const tenantId = resolution.scope.tenantId;

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return {
      ...empty,
      rowResults: [{ line: 0, status: "error", message: "No file selected" }],
    };
  }
  if (file.size > 5_000_000) {
    return {
      ...empty,
      rowResults: [
        { line: 0, status: "error", message: "File too large (max 5MB)" },
      ],
    };
  }

  const text = await file.text();
  const rows = parseCsv(text);
  if (rows.length === 0) {
    return {
      ...empty,
      rowResults: [{ line: 0, status: "error", message: "Empty file" }],
    };
  }

  const header = rows[0]!.map((h) => h.toLowerCase().trim());

  // Optional explicit overrides from the smart uploader (column-mapper UI).
  // When present, locate the named header from the user's file. When
  // absent, fall back to the default template names.
  const overrideDistributor = String(
    formData.get("col_distributor_account_id") ?? "",
  )
    .toLowerCase()
    .trim();
  const overrideDistributorName = String(
    formData.get("col_distributor_account_name") ?? "",
  )
    .toLowerCase()
    .trim();
  const overrideVeeva = String(formData.get("col_veeva_account_id") ?? "")
    .toLowerCase()
    .trim();

  const idx = {
    distributor: overrideDistributor
      ? header.indexOf(overrideDistributor)
      : header.indexOf("distributor_account_id"),
    distributorName: overrideDistributorName
      ? header.indexOf(overrideDistributorName)
      : header.indexOf("distributor_account_name"),
    veeva: overrideVeeva
      ? header.indexOf(overrideVeeva)
      : header.indexOf("veeva_account_id"),
  };
  if (idx.distributor < 0 || idx.veeva < 0) {
    const expected =
      overrideDistributor || overrideVeeva
        ? `distributor_account_id ↔ "${overrideDistributor || "(unmapped)"}", veeva_account_id ↔ "${overrideVeeva || "(unmapped)"}"`
        : "distributor_account_id, veeva_account_id (distributor_account_name optional)";
    return {
      ...empty,
      rowResults: [
        {
          line: 1,
          status: "error",
          message: `Could not locate required column(s) in file. Expected: ${expected}.`,
        },
      ],
    };
  }

  // Collect every distinct value the admin put in the veeva_account_id
  // column across all rows. We try to resolve each value across multiple
  // candidate ID columns (veeva_account_id, network_id, npi, dea_number,
  // aha_id) so transitioning clients can drop in a file keyed off
  // whichever ID their predecessor used. Two bulk queries (HCP + HCO),
  // not N round-trips.
  const candidateValues = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const v = (rows[i]?.[idx.veeva] ?? "").trim();
    if (v) candidateValues.add(v);
  }

  // Resolution map: user's value → { veeva_account_id (canonical), field
  // that matched }. If the user gave an NPI, we look it up in dim_hcp/hco
  // and store the canonical CRM account id as the resolved target.
  const resolved = new Map<string, { veevaAccountId: string; field: ResolutionField }>();

  if (candidateValues.size > 0) {
    const sanitized = Array.from(candidateValues)
      .map((v) => `'${v.replace(/'/g, "''")}'`)
      .join(",");

    // Pull every candidate ID column in one shot per dim. Order in the
    // priority loop below determines which field "wins" if two dim rows
    // happen to claim the same string value via different fields (rare).
    const [hcoRows, hcpRows] = await Promise.all([
      queryFabric<{
        veeva_account_id: string;
        network_id: string | null;
        npi: string | null;
        dea_number: string | null;
        aha_id: string | null;
      }>(
        tenantId,
        `SELECT veeva_account_id, network_id, npi, dea_number, aha_id
         FROM gold.dim_hco
         WHERE tenant_id = @tenantId
           AND ( veeva_account_id IN (${sanitized})
              OR network_id       IN (${sanitized})
              OR npi              IN (${sanitized})
              OR dea_number       IN (${sanitized})
              OR aha_id           IN (${sanitized}) )`,
      ),
      queryFabric<{
        veeva_account_id: string;
        network_id: string | null;
        npi: string | null;
        dea_number: string | null;
      }>(
        tenantId,
        `SELECT veeva_account_id, network_id, npi, dea_number
         FROM gold.dim_hcp
         WHERE tenant_id = @tenantId
           AND ( veeva_account_id IN (${sanitized})
              OR network_id       IN (${sanitized})
              OR npi              IN (${sanitized})
              OR dea_number       IN (${sanitized}) )`,
      ),
    ]);

    // Walk priority order. First field to claim a user value wins so a
    // single distributor row doesn't double-resolve.
    const claim = (
      value: string | null,
      veevaAccountId: string,
      field: ResolutionField,
    ) => {
      if (!value) return;
      const trimmed = value.trim();
      if (!trimmed) return;
      if (!candidateValues.has(trimmed)) return;
      if (resolved.has(trimmed)) return;
      resolved.set(trimmed, { veevaAccountId, field });
    };
    // Priority: native veeva_account_id first (cheapest reference, most
    // common from our own template). Then Network ID (canonical
    // cross-system), then NPI (universal HCP key), then DEA, then AHA.
    for (const r of hcoRows) claim(r.veeva_account_id, r.veeva_account_id, "veeva_account_id");
    for (const r of hcpRows) claim(r.veeva_account_id, r.veeva_account_id, "veeva_account_id");
    for (const r of hcoRows) claim(r.network_id, r.veeva_account_id, "network_id");
    for (const r of hcpRows) claim(r.network_id, r.veeva_account_id, "network_id");
    for (const r of hcoRows) claim(r.npi, r.veeva_account_id, "npi");
    for (const r of hcpRows) claim(r.npi, r.veeva_account_id, "npi");
    for (const r of hcoRows) claim(r.dea_number, r.veeva_account_id, "dea_number");
    for (const r of hcpRows) claim(r.dea_number, r.veeva_account_id, "dea_number");
    for (const r of hcoRows) claim(r.aha_id, r.veeva_account_id, "aha_id");
  }

  const breakdownCounts: Record<ResolutionField, number> = {
    veeva_account_id: 0,
    network_id: 0,
    npi: 0,
    dea_number: 0,
    aha_id: 0,
  };

  const results: UploadMappingsState["rowResults"] = [];
  let saved = 0;
  let skipped = 0;
  const updatedBy = resolution.scope.role;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i]!;
    const lineNum = i + 1;
    const distributorId = (row[idx.distributor] ?? "").trim();
    const distributorName =
      idx.distributorName >= 0
        ? (row[idx.distributorName] ?? "").trim()
        : "";
    const veevaId = (row[idx.veeva] ?? "").trim();

    if (!distributorId && !veevaId) continue; // blank line

    if (!distributorId || !veevaId) {
      // Only one ID present — typically a "Veeva master list" row in the
      // client's file with no distributor side yet, OR a template row the
      // admin hasn't filled in. Not actionable as a mapping (we need both
      // IDs to upsert), but not an error either. Count and move on.
      skipped += 1;
      continue;
    }
    const match = resolved.get(veevaId);
    if (!match) {
      results.push({
        line: lineNum,
        status: "error",
        message: `Value "${veevaId}" not found in dim_hcp/dim_hco via veeva_account_id, network_id, npi, dea_number, or aha_id`,
      });
      continue;
    }
    breakdownCounts[match.field] += 1;
    // Always store the canonical veeva_account_id (CRM record id) as the
    // mapping target — keeps the gold.fact_sale build's account_xref join
    // consistent regardless of which field the admin's file referenced.
    const canonicalVeevaId = match.veevaAccountId;
    const matchedVia =
      match.field === "veeva_account_id"
        ? ""
        : ` (via ${RESOLUTION_FIELD_LABELS[match.field]})`;

    const notes = distributorName
      ? `${distributorName} → ${canonicalVeevaId}${matchedVia}`
      : `→ ${canonicalVeevaId}${matchedVia}`;

    try {
      const existing = await db
        .select({ id: schema.mapping.id })
        .from(schema.mapping)
        .where(
          and(
            eq(schema.mapping.tenantId, tenantId),
            eq(schema.mapping.kind, "account_xref"),
            eq(schema.mapping.sourceKey, distributorId),
          ),
        )
        .limit(1);

      if (existing[0]) {
        await db
          .update(schema.mapping)
          .set({
            targetValue: canonicalVeevaId,
            notes,
            updatedBy,
            updatedAt: new Date(),
          })
          .where(eq(schema.mapping.id, existing[0].id));
      } else {
        await db.insert(schema.mapping).values({
          tenantId,
          kind: "account_xref",
          sourceKey: distributorId,
          targetValue: canonicalVeevaId,
          notes,
          effectiveFrom: new Date(),
          updatedBy,
        });
      }
      saved += 1;
      results.push({
        line: lineNum,
        status: "ok",
        message: `${distributorId} → ${canonicalVeevaId}${matchedVia}`,
      });
    } catch (err) {
      results.push({
        line: lineNum,
        status: "error",
        message: `DB error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  if (saved > 0) revalidatePath("/admin/mappings");

  // Per-field breakdown — empty buckets dropped so the UI only shows
  // fields that actually contributed.
  const resolutionBreakdown = (
    Object.keys(breakdownCounts) as ResolutionField[]
  )
    .filter((f) => breakdownCounts[f] > 0)
    .map((f) => ({
      field: f,
      label: RESOLUTION_FIELD_LABELS[f],
      count: breakdownCounts[f],
    }));

  return { saved, skipped, rowResults: results, resolutionBreakdown };
}

// Tiny CSV parser. Same shape as the goals upload — handles BOM, mixed
// CRLF/LF, quoted fields with embedded commas, and "#" comment lines used
// in templates.
function parseCsv(text: string): string[][] {
  const stripBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = stripBom.split(/\r?\n/);
  const rows: string[][] = [];
  for (const raw of lines) {
    if (raw.length === 0) continue;
    if (raw.startsWith("#")) continue;
    rows.push(splitCsvLine(raw));
  }
  return rows;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        cur += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Delete a saved mapping.
// ---------------------------------------------------------------------------

export async function deleteMappingAction(
  _prev: { error: string | null },
  formData: FormData,
): Promise<{ error: string | null }> {
  const { resolution } = await getCurrentScope();
  if (
    !resolution?.ok ||
    (resolution.scope.role !== "admin" && resolution.scope.role !== "bypass")
  ) {
    return { error: "Not authorized" };
  }
  const id = String(formData.get("id") ?? "");
  if (!id) return { error: "Missing id" };
  await db.delete(schema.mapping).where(eq(schema.mapping.id, id));
  revalidatePath("/admin/mappings");
  return { error: null };
}

// ---------------------------------------------------------------------------
// Trigger the mapping_propagate pipeline (config_sync →
// silver_account_xref_build → gold_fact_sale_build) via the Fabric REST
// API. Fire-and-forget — Fabric runs the orchestrator notebook in the
// background; we record the trigger to Postgres pipeline_run for the
// "last run" display, but don't poll for completion. UI just tells the
// admin "started, refresh in 2-3 min."
//
// Admin-only (reps don't manage mappings).
// ---------------------------------------------------------------------------

export type TriggerPipelineState = {
  error: string | null;
  success: string | null;
};

export async function triggerMappingPipelineAction(
  _prev: TriggerPipelineState,
  _formData: FormData,
): Promise<TriggerPipelineState> {
  const { resolution } = await getCurrentScope();
  if (
    !resolution?.ok ||
    (resolution.scope.role !== "admin" && resolution.scope.role !== "bypass")
  ) {
    return { error: "Not authorized", success: null };
  }
  const tenantId = resolution.scope.tenantId;
  const triggeredBy = resolution.scope.role;

  // Insert audit row at status=queued. The orchestrator notebook will
  // flip it to 'running' once it picks up the parameters, and to
  // 'succeeded' / 'failed' on completion via Supabase REST writeback.
  // Single source of truth — no double-writing from notebook side.
  const [run] = await db
    .insert(schema.pipelineRun)
    .values({
      scope: "tenant",
      tenantId,
      kind: "mapping_propagate",
      triggeredBy,
    })
    .returning({ id: schema.pipelineRun.id });

  try {
    const result = await triggerNotebookRun("mapping_propagate_pipeline", {
      pipeline_run_id: run?.id ?? null,
      tenant_id: tenantId,
      triggered_by: triggeredBy,
    });
    if (run) {
      // Just record the Fabric job instance id so Fabric Monitor can be
      // cross-referenced if needed. Status update is the notebook's job
      // now (it knows when it actually starts running vs queued behind
      // capacity).
      await db
        .update(schema.pipelineRun)
        .set({ jobInstanceId: result.jobInstanceId })
        .where(eq(schema.pipelineRun.id, run.id));
    }
    revalidatePath("/admin/mappings");
    return {
      error: null,
      success:
        "Pipeline started. Sales attribution will reflect new mappings in 2–3 minutes.",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (run) {
      await db
        .update(schema.pipelineRun)
        .set({
          status: "failed",
          message,
          finishedAt: new Date(),
        })
        .where(eq(schema.pipelineRun.id, run.id));
    }
    revalidatePath("/admin/mappings");
    return {
      error: `Trigger failed: ${message}`,
      success: null,
    };
  }
}

