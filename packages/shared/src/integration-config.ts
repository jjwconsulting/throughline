import { z } from "zod";
import { TenantIdSchema } from "./tenant";

const FeedNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9_]*$/, "snake_case identifier");

export const VeevaIntegrationConfigSchema = z.object({
  tenantId: TenantIdSchema,
  vaultDomain: z.string().min(1),
  username: z.string().min(1),
  passwordSecretUri: z.string().min(1),
  enabled: z.boolean(),
  updatedAt: z.coerce.date(),
});
export type VeevaIntegrationConfig = z.infer<typeof VeevaIntegrationConfigSchema>;

export const SftpIntegrationConfigSchema = z.object({
  tenantId: TenantIdSchema,
  host: z.string().min(1),
  username: z.string().min(1),
  keySecretUri: z.string().min(1),
  basePath: z.string().min(1),
  enabled: z.boolean(),
  updatedAt: z.coerce.date(),
});
export type SftpIntegrationConfig = z.infer<typeof SftpIntegrationConfigSchema>;

export const EmailDropConfigSchema = z.object({
  id: z.string().uuid(),
  tenantId: TenantIdSchema,
  feedName: FeedNameSchema,
  sourceAddress: z.string().email(),
  subjectPattern: z.string().min(1),
  enabled: z.boolean(),
  updatedAt: z.coerce.date(),
});
export type EmailDropConfig = z.infer<typeof EmailDropConfigSchema>;
