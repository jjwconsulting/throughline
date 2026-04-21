import { z } from "zod";

export const TenantIdSchema = z.string().uuid();
export type TenantId = z.infer<typeof TenantIdSchema>;

export const TenantSchema = z.object({
  id: TenantIdSchema,
  slug: z
    .string()
    .min(2)
    .max(63)
    .regex(/^[a-z0-9-]+$/, "lowercase letters, digits, hyphens"),
  name: z.string().min(1),
  fabricWorkspaceId: z.string().uuid(),
  powerBiWorkspaceId: z.string().uuid(),
  createdAt: z.coerce.date(),
});
export type Tenant = z.infer<typeof TenantSchema>;
