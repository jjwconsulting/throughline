CREATE TABLE IF NOT EXISTS "call_brief_cache" (
	"tenant_id" uuid NOT NULL,
	"rep_user_key" text NOT NULL,
	"entity_kind" text NOT NULL,
	"entity_key" text NOT NULL,
	"pipeline_run_id" uuid NOT NULL,
	"body" text NOT NULL,
	"input_snapshot" text,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "call_brief_cache_tenant_id_rep_user_key_entity_kind_entity_key_pipeline_run_id_pk" PRIMARY KEY("tenant_id","rep_user_key","entity_kind","entity_key","pipeline_run_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call_brief_cache" ADD CONSTRAINT "call_brief_cache_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call_brief_cache" ADD CONSTRAINT "call_brief_cache_pipeline_run_id_pipeline_run_id_fk" FOREIGN KEY ("pipeline_run_id") REFERENCES "public"."pipeline_run"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
