// Server-only. Lists active field reps from gold.dim_user with their
// invitation status — drives the "Invite from Veeva" panel. The customer's
// reps already exist in their Veeva data; we just match Clerk identities to
// them rather than asking admins to invent users.

import { eq, and, schema } from "@throughline/db";
import { db } from "@/lib/db";
import { queryFabric } from "@/lib/fabric";

export type VeevaRep = {
  user_key: string;
  name: string;
  email: string | null;
  title: string | null;
  user_type: string | null;
  // Provisioning status: have we already created a tenant_user row keyed to
  // this veeva_user_key?
  provisioned: boolean;
  // The email on the existing tenant_user row, if provisioned. May differ
  // from the Veeva email (an admin overrode it during invite).
  provisioned_email: string | null;
};

export async function loadVeevaRepsForInvite(
  tenantId: string,
): Promise<VeevaRep[]> {
  // Pull reps from the lakehouse (Fabric SQL endpoint).
  const reps = await queryFabric<{
    user_key: string;
    name: string;
    email: string | null;
    title: string | null;
    user_type: string | null;
  }>(
    tenantId,
    `SELECT user_key, name, email, title, user_type
     FROM gold.dim_user
     WHERE tenant_id = @tenantId
       AND status = 'Active'
       AND user_type IN ('Sales', 'Medical')
     ORDER BY name`,
  );

  // Pull existing tenant_user rows once for the same tenant; do the join in
  // memory (cheaper than per-rep queries, and the lakehouse + Postgres are
  // separate stores so we can't JOIN across them).
  const provisioned = await db
    .select({
      veevaUserKey: schema.tenantUser.veevaUserKey,
      userEmail: schema.tenantUser.userEmail,
    })
    .from(schema.tenantUser)
    .where(
      and(
        eq(schema.tenantUser.tenantId, tenantId),
        // Only consider rows with a Veeva mapping; admin/bypass rows have null
        // veeva_user_key and shouldn't shadow a rep.
      ),
    );
  const byKey = new Map(
    provisioned
      .filter((p) => p.veevaUserKey != null)
      .map((p) => [p.veevaUserKey as string, p.userEmail]),
  );

  return reps.map((r) => ({
    ...r,
    provisioned: byKey.has(r.user_key),
    provisioned_email: byKey.get(r.user_key) ?? null,
  }));
}
