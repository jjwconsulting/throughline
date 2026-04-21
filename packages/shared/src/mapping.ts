import { z } from "zod";
import { TenantIdSchema } from "./tenant";

export const MappingTableKindSchema = z.enum([
  "product",
  "territory",
  "hco_channel",
  "customer_type",
  "custom_grouping",
]);
export type MappingTableKind = z.infer<typeof MappingTableKindSchema>;

export const MappingRowSchema = z.object({
  id: z.string().uuid(),
  tenantId: TenantIdSchema,
  kind: MappingTableKindSchema,
  sourceKey: z.string().min(1),
  targetValue: z.string().min(1),
  notes: z.string().optional(),
  effectiveFrom: z.coerce.date(),
  effectiveTo: z.coerce.date().nullable(),
  updatedBy: z.string(),
  updatedAt: z.coerce.date(),
});
export type MappingRow = z.infer<typeof MappingRowSchema>;
