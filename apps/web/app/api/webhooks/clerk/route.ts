// Clerk webhook receiver. Provisions tenant_user rows when a Clerk user is
// created, so admins don't have to hand-run SQL after every invite.
//
// **The provisioning contract.** Tenant + role + Veeva mapping come from the
// Clerk user's `public_metadata`, set when the admin sends the invite (via
// the Clerk dashboard or our admin UI eventually):
//
//   public_metadata = {
//     tenant_slug:    "fennecpharma",   // required — looked up against tenant.slug
//     role:           "admin" | "manager" | "rep" | "bypass",  // optional, default 'rep'
//     veeva_user_key: "<gold.dim_user.user_key>",  // required if role='rep'
//   }
//
// Without `tenant_slug` the webhook accepts the event but logs and skips —
// the user signs in and lands on the "no access" page. An admin needs to
// either set the metadata and re-trigger, or run SQL.
//
// Setup: see docs/architecture/clerk-webhooks.md.

import { NextRequest, NextResponse } from "next/server";
import { Webhook, type WebhookVerificationError } from "svix";
import { eq, schema } from "@throughline/db";
import { db } from "@/lib/db";

// Clerk's user.created event payload — abbreviated to fields we care about.
type ClerkUserCreatedEvent = {
  type: "user.created" | "user.updated" | string;
  data: {
    id: string;
    email_addresses?: Array<{
      id: string;
      email_address: string;
    }>;
    primary_email_address_id?: string | null;
    public_metadata?: {
      tenant_slug?: string;
      role?: "admin" | "manager" | "rep" | "bypass";
      veeva_user_key?: string;
    };
  };
};

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.CLERK_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CLERK_WEBHOOK_SECRET not configured" },
      { status: 500 },
    );
  }

  // Svix headers — Clerk forwards these. Need raw body bytes for verification.
  const svixId = req.headers.get("svix-id");
  const svixTimestamp = req.headers.get("svix-timestamp");
  const svixSignature = req.headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return NextResponse.json(
      { error: "Missing svix headers" },
      { status: 400 },
    );
  }

  const body = await req.text();

  let event: ClerkUserCreatedEvent;
  try {
    const wh = new Webhook(secret);
    event = wh.verify(body, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    }) as ClerkUserCreatedEvent;
  } catch (err) {
    return NextResponse.json(
      {
        error: "Webhook signature verification failed",
        detail: (err as WebhookVerificationError).message,
      },
      { status: 401 },
    );
  }

  // Provision on user.created and user.updated. Updates let admins fix
  // missing metadata after the fact by editing the Clerk user.
  if (event.type !== "user.created" && event.type !== "user.updated") {
    return NextResponse.json({ ignored: event.type }, { status: 200 });
  }

  const userEmail = pickPrimaryEmail(event.data);
  if (!userEmail) {
    console.warn(`[clerk-webhook] ${event.type} ${event.data.id}: no email, skipping`);
    return NextResponse.json({ skipped: "no_email" }, { status: 200 });
  }

  const meta = event.data.public_metadata ?? {};
  const tenantSlug = meta.tenant_slug;
  const role = meta.role ?? "rep";
  const veevaUserKey = meta.veeva_user_key ?? null;

  if (!tenantSlug) {
    console.warn(
      `[clerk-webhook] ${event.type} ${userEmail}: no tenant_slug in metadata, skipping`,
    );
    return NextResponse.json({ skipped: "no_tenant_slug" }, { status: 200 });
  }

  const tenantRows = await db
    .select({ id: schema.tenant.id })
    .from(schema.tenant)
    .where(eq(schema.tenant.slug, tenantSlug))
    .limit(1);
  const tenantId = tenantRows[0]?.id;
  if (!tenantId) {
    console.warn(
      `[clerk-webhook] ${event.type} ${userEmail}: tenant_slug "${tenantSlug}" not found`,
    );
    return NextResponse.json({ error: "tenant_not_found" }, { status: 422 });
  }

  // The check constraint enforces (role='rep' → veeva_user_key NOT NULL).
  // Reject early with a clear error rather than letting the DB throw.
  if (role === "rep" && !veevaUserKey) {
    console.warn(
      `[clerk-webhook] ${event.type} ${userEmail}: role='rep' requires veeva_user_key`,
    );
    return NextResponse.json(
      { error: "rep_role_needs_veeva_user_key" },
      { status: 422 },
    );
  }

  await db
    .insert(schema.tenantUser)
    .values({
      tenantId,
      userEmail,
      role,
      veevaUserKey,
    })
    .onConflictDoUpdate({
      target: [schema.tenantUser.tenantId, schema.tenantUser.userEmail],
      set: {
        role,
        veevaUserKey,
        updatedAt: new Date(),
      },
    });

  return NextResponse.json({
    provisioned: { userEmail, tenantSlug, role, veevaUserKey },
  });
}

function pickPrimaryEmail(
  data: ClerkUserCreatedEvent["data"],
): string | null {
  const addresses = data.email_addresses ?? [];
  if (addresses.length === 0) return null;
  const primaryId = data.primary_email_address_id;
  const primary = primaryId
    ? addresses.find((a) => a.id === primaryId)
    : null;
  return (primary ?? addresses[0])?.email_address ?? null;
}
