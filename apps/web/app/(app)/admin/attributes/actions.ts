"use server";

import { revalidatePath } from "next/cache";
import { and, eq, schema } from "@throughline/db";
import { db } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import {
  listBronzeColumnsForTable,
  type BronzeColumn,
} from "@/lib/bronze-introspection";

// Lazy-fetch bronze columns for a selected bronze table. Called from
// the attribute form's client-side cascading dropdown when the admin
// picks a table — avoids preloading hundreds of columns × N tables
// up-front.
export async function listBronzeColumnsAction(
  bronzeTable: string,
): Promise<{ ok: true; columns: BronzeColumn[] } | { ok: false; error: string }> {
  const { resolution } = await getCurrentScope();
  if (
    !resolution?.ok ||
    (resolution.scope.role !== "admin" && resolution.scope.role !== "bypass")
  ) {
    return { ok: false, error: "Not authorized" };
  }
  if (!bronzeTable || bronzeTable.trim().length === 0) {
    return { ok: false, error: "bronze_table required" };
  }
  const tenantRow = await db
    .select({ slug: schema.tenant.slug })
    .from(schema.tenant)
    .where(eq(schema.tenant.id, resolution.scope.tenantId))
    .limit(1);
  const tenantSlug = tenantRow[0]?.slug;
  if (!tenantSlug) return { ok: false, error: "Tenant slug not found" };
  const columns = await listBronzeColumnsForTable(
    resolution.scope.tenantId,
    tenantSlug,
    bronzeTable,
  );
  return { ok: true, columns };
}

// Server actions for /admin/attributes — CRUD over tenant_attribute_map.
// Only admin / bypass can mutate. Tenant scoping enforced by ANDing
// the row's tenant_id with the resolved scope.

export type ActionResult = { ok: true } | { ok: false; error: string };

type AttributeFormShape = {
  source_system: string;
  bronze_table: string;
  bronze_column: string;
  attribute_name: string;
  entity_type: string;
  attribute_type: string;
  source_label: string;
  scope_tag: string;
};

function readFormData(formData: FormData): AttributeFormShape {
  return {
    source_system: String(formData.get("source_system") ?? "").trim(),
    bronze_table: String(formData.get("bronze_table") ?? "").trim(),
    bronze_column: String(formData.get("bronze_column") ?? "").trim(),
    attribute_name: String(formData.get("attribute_name") ?? "").trim(),
    entity_type: String(formData.get("entity_type") ?? "").trim(),
    attribute_type: String(formData.get("attribute_type") ?? "").trim(),
    source_label: String(formData.get("source_label") ?? "").trim(),
    scope_tag: String(formData.get("scope_tag") ?? "").trim(),
  };
}

function validate(shape: AttributeFormShape): string | null {
  if (!shape.source_system) return "source_system required";
  if (!shape.bronze_table) return "bronze_table required";
  if (!shape.bronze_column) return "bronze_column required";
  if (!shape.attribute_name) return "attribute_name required";
  if (!shape.entity_type) return "entity_type required";
  if (!shape.attribute_type) return "attribute_type required";
  if (!shape.source_label) return "source_label required";
  if (!["hcp", "hco"].includes(shape.entity_type)) {
    return `entity_type must be 'hcp' or 'hco'; got '${shape.entity_type}'`;
  }
  return null;
}

export async function createAttributeMappingAction(
  formData: FormData,
): Promise<ActionResult> {
  const { resolution } = await getCurrentScope();
  if (
    !resolution?.ok ||
    (resolution.scope.role !== "admin" && resolution.scope.role !== "bypass")
  ) {
    return { ok: false, error: "Not authorized" };
  }
  const shape = readFormData(formData);
  const validationError = validate(shape);
  if (validationError) return { ok: false, error: validationError };

  // Bypass users can target any tenant via a hidden tenant_id_override
  // on the form; admins always target their own tenant.
  const overrideTenantId =
    resolution.scope.role === "bypass"
      ? String(formData.get("tenant_id_override") ?? "")
      : "";
  const tenantId = overrideTenantId || resolution.scope.tenantId;

  try {
    await db
      .insert(schema.tenantAttributeMap)
      .values({
        tenantId,
        sourceSystem: shape.source_system as
          | "veeva"
          | "sftp"
          | "email"
          | "hubspot",
        bronzeTable: shape.bronze_table,
        bronzeColumn: shape.bronze_column,
        attributeName: shape.attribute_name,
        entityType: shape.entity_type as "hcp" | "hco",
        attributeType: shape.attribute_type as
          | "decile"
          | "score"
          | "volume"
          | "percentile"
          | "categorical"
          | "flag",
        sourceLabel: shape.source_label,
        scopeTag: shape.scope_tag || null,
        active: true,
        updatedBy: resolution.scope.role,
      })
      .onConflictDoUpdate({
        target: [
          schema.tenantAttributeMap.tenantId,
          schema.tenantAttributeMap.sourceSystem,
          schema.tenantAttributeMap.bronzeTable,
          schema.tenantAttributeMap.bronzeColumn,
        ],
        set: {
          attributeName: shape.attribute_name,
          entityType: shape.entity_type as "hcp" | "hco",
          attributeType: shape.attribute_type as
            | "decile"
            | "score"
            | "volume"
            | "percentile"
            | "categorical"
            | "flag",
          sourceLabel: shape.source_label,
          scopeTag: shape.scope_tag || null,
          updatedAt: new Date(),
          updatedBy: resolution.scope.role,
        },
      });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  revalidatePath("/admin/attributes");
  return { ok: true };
}

export async function toggleAttributeActiveAction(
  formData: FormData,
): Promise<ActionResult> {
  const { resolution } = await getCurrentScope();
  if (
    !resolution?.ok ||
    (resolution.scope.role !== "admin" && resolution.scope.role !== "bypass")
  ) {
    return { ok: false, error: "Not authorized" };
  }
  const id = String(formData.get("id") ?? "");
  const next = String(formData.get("next") ?? "true") === "true";
  if (!id) return { ok: false, error: "id required" };

  // Tenant scoping: admins can only toggle rows in their own tenant.
  // Bypass users can toggle any tenant's rows.
  const tenantClause =
    resolution.scope.role === "admin"
      ? and(
          eq(schema.tenantAttributeMap.id, id),
          eq(schema.tenantAttributeMap.tenantId, resolution.scope.tenantId),
        )
      : eq(schema.tenantAttributeMap.id, id);

  await db
    .update(schema.tenantAttributeMap)
    .set({
      active: next,
      updatedAt: new Date(),
      updatedBy: resolution.scope.role,
    })
    .where(tenantClause);

  revalidatePath("/admin/attributes");
  return { ok: true };
}

export async function deleteAttributeMappingAction(
  formData: FormData,
): Promise<ActionResult> {
  const { resolution } = await getCurrentScope();
  if (
    !resolution?.ok ||
    (resolution.scope.role !== "admin" && resolution.scope.role !== "bypass")
  ) {
    return { ok: false, error: "Not authorized" };
  }
  const id = String(formData.get("id") ?? "");
  if (!id) return { ok: false, error: "id required" };

  const tenantClause =
    resolution.scope.role === "admin"
      ? and(
          eq(schema.tenantAttributeMap.id, id),
          eq(schema.tenantAttributeMap.tenantId, resolution.scope.tenantId),
        )
      : eq(schema.tenantAttributeMap.id, id);

  await db.delete(schema.tenantAttributeMap).where(tenantClause);
  revalidatePath("/admin/attributes");
  return { ok: true };
}
