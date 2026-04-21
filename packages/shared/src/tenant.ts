import { z } from "zod";

export const TenantIdSchema = z.string().uuid();
export type TenantId = z.infer<typeof TenantIdSchema>;

export const TenantSlugSchema = z
  .string()
  .min(2)
  .max(63)
  .regex(/^[a-z0-9-]+$/, "lowercase letters, digits, hyphens");
export type TenantSlug = z.infer<typeof TenantSlugSchema>;

export const TenantStatusSchema = z.enum(["active", "paused", "archived"]);
export type TenantStatus = z.infer<typeof TenantStatusSchema>;

export const TenantSchema = z.object({
  id: TenantIdSchema,
  slug: TenantSlugSchema,
  name: z.string().min(1),
  status: TenantStatusSchema,
  createdAt: z.coerce.date(),
});
export type Tenant = z.infer<typeof TenantSchema>;

export const TenantCreateInputSchema = z.object({
  slug: TenantSlugSchema,
  name: z.string().min(1, "Name is required"),
});
export type TenantCreateInput = z.infer<typeof TenantCreateInputSchema>;
