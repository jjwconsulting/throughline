CREATE TYPE "public"."tenant_user_role" AS ENUM('admin', 'manager', 'rep', 'bypass');--> statement-breakpoint
-- Backfill existing rows as 'admin' (whoever set up the tenant pre-RLS),
-- then switch the default to 'rep' for future inserts.
ALTER TABLE "tenant_user" ADD COLUMN "role" "tenant_user_role" DEFAULT 'admin' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenant_user" ALTER COLUMN "role" SET DEFAULT 'rep';--> statement-breakpoint
ALTER TABLE "tenant_user" ADD COLUMN "veeva_user_key" text;--> statement-breakpoint
ALTER TABLE "tenant_user" ADD CONSTRAINT "tenant_user_rep_needs_user_key" CHECK ("tenant_user"."role" <> 'rep' OR "tenant_user"."veeva_user_key" IS NOT NULL);
