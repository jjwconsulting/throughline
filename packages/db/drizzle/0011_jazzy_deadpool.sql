CREATE TYPE "public"."attribute_entity_type" AS ENUM('hcp', 'hco');--> statement-breakpoint
CREATE TYPE "public"."attribute_type" AS ENUM('decile', 'score', 'volume', 'percentile', 'categorical', 'flag');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenant_attribute_map" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source_system" "source_system" NOT NULL,
	"bronze_table" text NOT NULL,
	"bronze_column" text NOT NULL,
	"attribute_name" text NOT NULL,
	"entity_type" "attribute_entity_type" NOT NULL,
	"attribute_type" "attribute_type" NOT NULL,
	"source_label" text NOT NULL,
	"scope_tag" text,
	"active" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL,
	CONSTRAINT "tenant_attribute_map_bronze_location_uniq" UNIQUE("tenant_id","source_system","bronze_table","bronze_column")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_attribute_map" ADD CONSTRAINT "tenant_attribute_map_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
