CREATE TYPE "public"."pipeline_scope" AS ENUM('global', 'tenant');--> statement-breakpoint
ALTER TYPE "public"."pipeline_kind" ADD VALUE 'incremental_refresh';--> statement-breakpoint
ALTER TYPE "public"."pipeline_kind" ADD VALUE 'weekly_full_refresh';--> statement-breakpoint
ALTER TYPE "public"."pipeline_kind" ADD VALUE 'delta_maintenance';--> statement-breakpoint
ALTER TABLE "pipeline_run" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_run" ADD COLUMN "scope" "pipeline_scope" DEFAULT 'tenant' NOT NULL;--> statement-breakpoint
ALTER TABLE "pipeline_run" ADD COLUMN "step_metrics" text;--> statement-breakpoint
ALTER TABLE "pipeline_run" ADD COLUMN "error" text;