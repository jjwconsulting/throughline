CREATE TABLE IF NOT EXISTS "synopsis_cache" (
	"tenant_id" uuid NOT NULL,
	"user_email" text NOT NULL,
	"pipeline_run_id" uuid NOT NULL,
	"body" text NOT NULL,
	"input_snapshot" text,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "synopsis_cache_tenant_id_user_email_pipeline_run_id_pk" PRIMARY KEY("tenant_id","user_email","pipeline_run_id")
);
--> statement-breakpoint
ALTER TABLE "tenant_user" ADD COLUMN "last_dismissed_synopsis_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "synopsis_cache" ADD CONSTRAINT "synopsis_cache_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "synopsis_cache" ADD CONSTRAINT "synopsis_cache_pipeline_run_id_pipeline_run_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_run"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
