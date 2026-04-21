import { z } from "zod";
import { TenantIdSchema } from "./tenant";

export const TenantUserSchema = z.object({
  tenantId: TenantIdSchema,
  userEmail: z.string().email(),
  effectiveTerritoryIds: z.array(z.string().min(1)).nullable(),
  updatedAt: z.coerce.date(),
});
export type TenantUser = z.infer<typeof TenantUserSchema>;
