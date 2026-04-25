CREATE TYPE "public"."sftp_feed_type" AS ENUM('full_snapshot', 'incremental');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_sftp_feed" (
	"tenant_id" uuid NOT NULL,
	"feed_name" text NOT NULL,
	"feed_type" "sftp_feed_type" NOT NULL,
	"silver_table" "silver_table" NOT NULL,
	"notes" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_sftp_feed_tenant_id_feed_name_pk" PRIMARY KEY("tenant_id","feed_name"),
	CONSTRAINT "tenant_sftp_feed_feed_name_format" CHECK ("tenant_sftp_feed"."feed_name" ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_sftp_feed" ADD CONSTRAINT "tenant_sftp_feed_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
