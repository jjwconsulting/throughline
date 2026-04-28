"use server";

import { revalidatePath } from "next/cache";
import { and, eq, schema } from "@throughline/db";
import { db } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";

// Marks the synopsis as dismissed for the current data refresh. The
// next /dashboard load will hide the card until a new pipeline_run
// completes (synopsis lifecycle described in lib/synopsis.ts).
export async function dismissSynopsisAction(): Promise<void> {
  const { userEmail, resolution } = await getCurrentScope();
  if (!resolution?.ok || !userEmail) return;

  await db
    .update(schema.tenantUser)
    .set({ lastDismissedSynopsisAt: new Date() })
    .where(
      and(
        eq(schema.tenantUser.tenantId, resolution.scope.tenantId),
        eq(schema.tenantUser.userEmail, userEmail),
      ),
    );

  revalidatePath("/dashboard");
}
