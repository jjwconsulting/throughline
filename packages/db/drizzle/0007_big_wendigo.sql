CREATE TYPE "public"."pipeline_kind" AS ENUM('mapping_propagate');--> statement-breakpoint
CREATE TYPE "public"."pipeline_status" AS ENUM('queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "pipeline_run" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "pipeline_kind" NOT NULL,
	"job_instance_id" text,
	"status" "pipeline_status" DEFAULT 'queued' NOT NULL,
	"message" text,
	"triggered_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "pipeline_run" ADD CONSTRAINT "pipeline_run_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
