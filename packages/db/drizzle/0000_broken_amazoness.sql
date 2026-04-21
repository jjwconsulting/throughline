CREATE TYPE "public"."mapping_kind" AS ENUM('product', 'territory', 'hco_channel', 'customer_type', 'custom_grouping');--> statement-breakpoint
CREATE TYPE "public"."silver_table" AS ENUM('hcp', 'hco', 'territory', 'call', 'user');--> statement-breakpoint
CREATE TYPE "public"."source_system" AS ENUM('veeva', 'sftp', 'email', 'hubspot');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('active', 'paused', 'archived');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "mapping_kind" NOT NULL,
	"source_key" text NOT NULL,
	"target_value" text NOT NULL,
	"notes" text,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_to" timestamp with time zone,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" "tenant_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenant_slug_format" CHECK ("tenant"."slug" ~ '^[a-z0-9-]{2,63}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_email_drop" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"feed_name" text NOT NULL,
	"source_address" text NOT NULL,
	"subject_pattern" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_email_drop_unique" UNIQUE("tenant_id","feed_name"),
	CONSTRAINT "tenant_email_drop_feed_name_format" CHECK ("tenant_email_drop"."feed_name" ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_sftp" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"host" text NOT NULL,
	"username" text NOT NULL,
	"key_secret_uri" text NOT NULL,
	"base_path" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_source_field_map" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_system" "source_system" NOT NULL,
	"silver_table" "silver_table" NOT NULL,
	"silver_column" text NOT NULL,
	"bronze_source_table" text NOT NULL,
	"bronze_source_column" text,
	"default_value" text,
	"transform_sql" text,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_source_field_map_unique" UNIQUE("tenant_id","silver_table","silver_column"),
	CONSTRAINT "tenant_source_field_map_source_required" CHECK ("tenant_source_field_map"."bronze_source_column" IS NOT NULL OR "tenant_source_field_map"."default_value" IS NOT NULL),
	CONSTRAINT "tenant_source_field_map_silver_column_format" CHECK ("tenant_source_field_map"."silver_column" ~ '^[a-z][a-z0-9_]*$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_user" (
	"tenant_id" uuid NOT NULL,
	"user_email" text NOT NULL,
	"effective_territory_ids" text[],
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_user_tenant_id_user_email_pk" PRIMARY KEY("tenant_id","user_email")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_veeva" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"vault_domain" text NOT NULL,
	"username" text NOT NULL,
	"password_secret_uri" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mapping" ADD CONSTRAINT "mapping_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_email_drop" ADD CONSTRAINT "tenant_email_drop_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_sftp" ADD CONSTRAINT "tenant_sftp_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_source_field_map" ADD CONSTRAINT "tenant_source_field_map_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_user" ADD CONSTRAINT "tenant_user_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_veeva" ADD CONSTRAINT "tenant_veeva_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
