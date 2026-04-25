"use server";

import { revalidatePath } from "next/cache";
import { and, eq, schema } from "@throughline/db";
import { db } from "@/lib/db";
import { queryFabric } from "@/lib/fabric";
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
