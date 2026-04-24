"use server";

import { revalidatePath } from "next/cache";
import { clerkClient } from "@clerk/nextjs/server";
import { eq, schema } from "@throughline/db";
import { db } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";

export type InviteUserState = {
  error: string | null;
  success: string | null;
};

const ROLES = ["admin", "manager", "rep", "bypass"] as const;
type Role = (typeof ROLES)[number];

export async function inviteUserAction(
  _prev: InviteUserState,
  formData: FormData,
): Promise<InviteUserState> {
  // Hard gate: only admin/bypass can invite. The page also gates rendering,
  // but the action is callable independently so it must check too.
  const { resolution } = await getCurrentScope();
  if (
    !resolution?.ok ||
    (resolution.scope.role !== "admin" && resolution.scope.role !== "bypass")
  ) {
    return { error: "Not authorized", success: null };
  }

  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const tenantSlug = String(formData.get("tenant_slug") ?? "").trim();
  const role = String(formData.get("role") ?? "") as Role;
  const veevaUserKeyRaw = String(formData.get("veeva_user_key") ?? "").trim();
  const veevaUserKey = veevaUserKeyRaw === "" ? null : veevaUserKeyRaw;

  if (!email || !email.includes("@")) {
    return { error: "Email is required", success: null };
  }
  if (!tenantSlug) {
    return { error: "Tenant is required", success: null };
  }
  if (!ROLES.includes(role)) {
    return { error: "Invalid role", success: null };
  }
  if (role === "rep" && !veevaUserKey) {
    return {
      error: "Rep role requires a Veeva user_key",
      success: null,
    };
  }

  // Verify the tenant exists in our DB before sending the invite — otherwise
  // the webhook will fail when the user accepts and the metadata is read.
  const tenantRows = await db
    .select({ id: schema.tenant.id })
    .from(schema.tenant)
    .where(eq(schema.tenant.slug, tenantSlug))
    .limit(1);
  if (!tenantRows[0]) {
    return { error: `Tenant "${tenantSlug}" not found`, success: null };
  }

  try {
    const clerk = await clerkClient();
    await clerk.invitations.createInvitation({
      emailAddress: email,
      publicMetadata: {
        tenant_slug: tenantSlug,
        role,
        ...(veevaUserKey ? { veeva_user_key: veevaUserKey } : {}),
      },
      // Optional: where Clerk sends the user after accepting. Must be an
      // ABSOLUTE URL allowlisted in Clerk dashboard. Set CLERK_INVITE_REDIRECT_URL
      // to enable; omit and Clerk uses its default sign-up flow.
      ...(process.env.CLERK_INVITE_REDIRECT_URL
        ? { redirectUrl: process.env.CLERK_INVITE_REDIRECT_URL }
        : {}),
    });
  } catch (err) {
    // Clerk SDK throws ClerkAPIResponseError with a `.errors` array carrying
    // the structured per-issue messages — much more useful than the generic
    // "Unprocessable Entity" outer message.
    type ClerkApiError = {
      message?: string;
      errors?: Array<{
        code?: string;
        message?: string;
        long_message?: string;
      }>;
    };
    const e = err as ClerkApiError;
    const detailed =
      e.errors
        ?.map((x) => x.long_message || x.message || x.code)
        .filter(Boolean)
        .join("; ") ?? null;
    const fallback = err instanceof Error ? err.message : String(err);
    // Always log the full payload server-side so we can see it in the dev
    // terminal even when the UI shows the friendly version.
    console.error("[invite] Clerk error", {
      email,
      tenantSlug,
      role,
      raw: err,
    });
    const msg = detailed ?? fallback;
    if (msg.toLowerCase().includes("already") || msg.toLowerCase().includes("duplicate")) {
      return {
        error:
          "An invitation already exists for this email, or the user already has an account in Clerk.",
        success: null,
      };
    }
    return { error: `Clerk invite failed: ${msg}`, success: null };
  }

  revalidatePath("/admin/users");
  return {
    error: null,
    success: `Invite sent to ${email}.`,
  };
}
