CREATE TYPE "public"."goal_entity_type" AS ENUM('rep', 'territory', 'region', 'tier', 'tenant_wide');--> statement-breakpoint
CREATE TYPE "public"."goal_metric" AS ENUM('calls', 'units', 'revenue', 'reach_pct', 'frequency');--> statement-breakpoint
CREATE TYPE "public"."goal_period_type" AS ENUM('month', 'quarter', 'year', 'custom');--> statement-breakpoint
CREATE TYPE "public"."goal_source" AS ENUM('manual', 'upload', 'recommended', 'scheduled');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"metric" "goal_metric" NOT NULL,
	"entity_type" "goal_entity_type" NOT NULL,
	"entity_id" text,
	"period_type" "goal_period_type" NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"goal_value" numeric(18, 4) NOT NULL,
	"goal_unit" text NOT NULL,
	"source" "goal_source" DEFAULT 'manual' NOT NULL,
	"recommendation_context" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goal_unique" UNIQUE("tenant_id","metric","entity_type","entity_id","period_start","period_end"),
	CONSTRAINT "goal_entity_id_required" CHECK ("goal"."entity_type" = 'tenant_wide' OR "goal"."entity_id" IS NOT NULL),
	CONSTRAINT "goal_period_ordered" CHECK ("goal"."period_end" >= "goal"."period_start"),
	CONSTRAINT "goal_value_non_negative" CHECK ("goal"."goal_value" >= 0)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "goal" ADD CONSTRAINT "goal_tenant_id_tenant_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenant"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
