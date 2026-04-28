CREATE TABLE IF NOT EXISTS "rep_recommendation_cache" (
	"tenant_id" uuid NOT NULL,
	"rep_user_key" text NOT NULL,
	"pipeline_run_id" uuid NOT NULL,
	"body" text NOT NULL,
	"input_snapshot" text,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rep_recommendation_cache_tenant_id_rep_user_key_pipeline_run_id_pk" PRIMARY KEY("tenant_id","rep_user_key","pipeline_run_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rep_recommendation_cache" ADD CONSTRAINT "rep_recommendation_cache_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "rep_recommendation_cache" ADD CONSTRAINT "rep_recommendation_cache_pipeline_run_id_pipeline_run_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_run"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
