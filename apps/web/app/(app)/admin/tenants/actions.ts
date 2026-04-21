"use server";

import { db } from "@/lib/db";
import { schema } from "@throughline/db";
import { TenantCreateInputSchema } from "@throughline/shared";
import { revalidatePath } from "next/cache";

export type CreateTenantState = {
  error: string | null;
  success: boolean;
};

export async function createTenantAction(
  _prev: CreateTenantState,
  formData: FormData,
): Promise<CreateTenantState> {
  const parsed = TenantCreateInputSchema.safeParse({
    slug: formData.get("slug"),
    name: formData.get("name"),
  });

  if (!parsed.success) {
    return {
      error: parsed.error.errors[0]?.message ?? "Invalid input",
      success: false,
    };
  }

  try {
    await db.insert(schema.tenant).values({
      slug: parsed.data.slug,
      name: parsed.data.name,
    });
  } catch (e: unknown) {
    if (
      typeof e === "object" &&
      e !== null &&
      "code" in e &&
      (e as { code: string }).code === "23505"
    ) {
      return {
        error: `slug "${parsed.data.slug}" is already in use`,
        success: false,
      };
    }
    return { error: "Failed to create tenant", success: false };
  }

  revalidatePath("/admin/tenants");
  return { error: null, success: true };
}
