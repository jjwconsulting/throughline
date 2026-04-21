import { z } from "zod";
import { TenantIdSchema } from "./tenant";

export const SourceSystemSchema = z.enum(["veeva", "sftp", "email", "hubspot"]);
export type SourceSystem = z.infer<typeof SourceSystemSchema>;

export const SilverTableSchema = z.enum([
  "hcp",
  "hco",
  "territory",
  "call",
  "user",
]);
export type SilverTable = z.infer<typeof SilverTableSchema>;

const SnakeCaseIdentifier = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9_]*$/, "snake_case identifier");

export const TenantSourceFieldMapSchema = z
  .object({
    id: z.string().uuid(),
    tenantId: TenantIdSchema,
    sourceSystem: SourceSystemSchema,
    silverTable: SilverTableSchema,
    silverColumn: SnakeCaseIdentifier,
    bronzeSourceTable: z.string().min(1),
    bronzeSourceColumn: z.string().min(1).nullable(),
    defaultValue: z.string().nullable(),
    transformSql: z.string().nullable(),
    updatedBy: z.string(),
    updatedAt: z.coerce.date(),
  })
  .refine(
    (row) => row.bronzeSourceColumn !== null || row.defaultValue !== null,
    {
      message:
        "either bronzeSourceColumn or defaultValue must be set — a silver column cannot be sourced from nothing",
      path: ["bronzeSourceColumn"],
    },
  );
export type TenantSourceFieldMap = z.infer<typeof TenantSourceFieldMapSchema>;
