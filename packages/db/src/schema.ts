import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const tenantStatusEnum = pgEnum("tenant_status", [
  "active",
  "paused",
  "archived",
]);

export const sourceSystemEnum = pgEnum("source_system", [
  "veeva",
  "sftp",
  "email",
  "hubspot",
]);

export const silverTableEnum = pgEnum("silver_table", [
  "hcp",
  "hco",
  "territory",
  "call",
  "user",
  "account_xref",
  "sale",
]);

export const mappingKindEnum = pgEnum("mapping_kind", [
  "product",
  "territory",
  "hco_channel",
  "customer_type",
  "custom_grouping",
  "account_xref",
]);

export const tenantUserRoleEnum = pgEnum("tenant_user_role", [
  "admin",
  "manager",
  "rep",
  "bypass",
]);

// Each value names a Fabric notebook (or pipeline) that the web app can
// trigger from /admin. Add a row here when wiring up a new triggerable
// pipeline (e.g. a future `veeva_refresh` button).
export const pipelineKindEnum = pgEnum("pipeline_kind", [
  "mapping_propagate",
]);

export const pipelineStatusEnum = pgEnum("pipeline_status", [
  "queued",
  "running",
  "succeeded",
  "failed",
]);

// SFTP feed cadence model. Drives the silver build's batch-selection logic:
//   full_snapshot — each new file is a complete snapshot (e.g. IntegriChain
//                   867 inception-to-date). Silver reads only rows from the
//                   latest source_file. Bronze can grow but never fills
//                   silver with duplicates.
//   incremental   — each new file is a delta (e.g. TriSalus daily extract).
//                   Silver reads all rows across all files; dedup by natural
//                   key happens upstream in source.
export const sftpFeedTypeEnum = pgEnum("sftp_feed_type", [
  "full_snapshot",
  "incremental",
]);

// Goal taxonomy. Open enums so we can extend without migrations as new
// metrics/entities land. The web app + recommendation engine validate
// against the values they actually understand.
export const goalMetricEnum = pgEnum("goal_metric", [
  "calls",
  "units",
  "revenue",
  "reach_pct",
  "frequency",
]);

export const goalEntityTypeEnum = pgEnum("goal_entity_type", [
  "rep",
  "territory",
  "region",
  "tier",
  "tenant_wide",
]);

export const goalPeriodTypeEnum = pgEnum("goal_period_type", [
  "month",
  "quarter",
  "year",
  "custom",
]);

export const goalSourceEnum = pgEnum("goal_source", [
  "manual",
  "upload",
  "recommended",
  "scheduled",
]);

export const tenant = pgTable(
  "tenant",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    status: tenantStatusEnum("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    slugFormat: check(
      "tenant_slug_format",
      sql`${t.slug} ~ '^[a-z0-9-]{2,63}$'`,
    ),
  }),
);

export const tenantSourceFieldMap = pgTable(
  "tenant_source_field_map",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    sourceSystem: sourceSystemEnum("source_system").notNull(),
    silverTable: silverTableEnum("silver_table").notNull(),
    silverColumn: text("silver_column").notNull(),
    bronzeSourceTable: text("bronze_source_table").notNull(),
    bronzeSourceColumn: text("bronze_source_column"),
    defaultValue: text("default_value"),
    transformSql: text("transform_sql"),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniq: unique("tenant_source_field_map_unique").on(
      t.tenantId,
      t.silverTable,
      t.silverColumn,
    ),
    sourceRequired: check(
      "tenant_source_field_map_source_required",
      sql`${t.bronzeSourceColumn} IS NOT NULL OR ${t.defaultValue} IS NOT NULL`,
    ),
    silverColumnFormat: check(
      "tenant_source_field_map_silver_column_format",
      sql`${t.silverColumn} ~ '^[a-z][a-z0-9_]*$'`,
    ),
  }),
);

export const mapping = pgTable("mapping", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenant.id, { onDelete: "cascade" }),
  kind: mappingKindEnum("kind").notNull(),
  sourceKey: text("source_key").notNull(),
  targetValue: text("target_value").notNull(),
  notes: text("notes"),
  effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
  effectiveTo: timestamp("effective_to", { withTimezone: true }),
  updatedBy: text("updated_by").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Audit + last-run-display log for admin-triggered Fabric pipelines.
// One row per trigger. status starts 'queued' on insert, web UI doesn't
// poll (yet) — admin sees the trigger ack and the wall clock; subsequent
// page loads show the most recent row's createdAt as "Last run X minutes
// ago." If we later add status polling, the row gets updated to running
// → succeeded / failed.
export const pipelineRun = pgTable("pipeline_run", {
  id: uuid("id").primaryKey().defaultRandom(),
  tenantId: uuid("tenant_id")
    .notNull()
    .references(() => tenant.id, { onDelete: "cascade" }),
  kind: pipelineKindEnum("kind").notNull(),
  // Fabric job instance id returned by the trigger API (location header
  // suffix). Populated when the trigger succeeds; null on synchronous
  // trigger failure (e.g. auth error before the API ever ran).
  jobInstanceId: text("job_instance_id"),
  status: pipelineStatusEnum("status").notNull().default("queued"),
  // Free-form text from API failure or notebook exit value. Bounded to
  // a few KB by Postgres text type; trim if the LLM-generated brief
  // ever needs to summarize this.
  message: text("message"),
  triggeredBy: text("triggered_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const tenantVeeva = pgTable("tenant_veeva", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenant.id, { onDelete: "cascade" }),
  vaultDomain: text("vault_domain").notNull(),
  username: text("username").notNull(),
  passwordSecretUri: text("password_secret_uri").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Per-feed metadata for SFTP drops. Different feeds under the same tenant
// can have different cadence (full snapshot vs incremental) and route to
// different silver tables. The bronze table name is always
// `bronze_<tenant_slug>.sftp_<feed_name>` (assembled by sftp_ingest).
export const tenantSftpFeed = pgTable(
  "tenant_sftp_feed",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    // The feed_name folder under Files/sftp/<tenant_slug>/<feed_name>/.
    feedName: text("feed_name").notNull(),
    feedType: sftpFeedTypeEnum("feed_type").notNull(),
    // Which silver table this feed populates. Drives which silver build
    // notebook should pick it up.
    silverTable: silverTableEnum("silver_table").notNull(),
    notes: text("notes"),
    enabled: boolean("enabled").notNull().default(true),
    updatedBy: text("updated_by").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.feedName] }),
    feedNameFormat: check(
      "tenant_sftp_feed_feed_name_format",
      sql`${t.feedName} ~ '^[a-z][a-z0-9_]*$'`,
    ),
  }),
);

export const tenantSftp = pgTable("tenant_sftp", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenant.id, { onDelete: "cascade" }),
  host: text("host").notNull(),
  username: text("username").notNull(),
  keySecretUri: text("key_secret_uri").notNull(),
  basePath: text("base_path").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const tenantEmailDrop = pgTable(
  "tenant_email_drop",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    feedName: text("feed_name").notNull(),
    sourceAddress: text("source_address").notNull(),
    subjectPattern: text("subject_pattern").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    uniq: unique("tenant_email_drop_unique").on(t.tenantId, t.feedName),
    feedNameFormat: check(
      "tenant_email_drop_feed_name_format",
      sql`${t.feedName} ~ '^[a-z][a-z0-9_]*$'`,
    ),
  }),
);

export const tenantUser = pgTable(
  "tenant_user",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    userEmail: text("user_email").notNull(),
    role: tenantUserRoleEnum("role").notNull().default("rep"),
    // The Veeva user_key in gold.dim_user this Clerk user maps to.
    // Required for role='rep' (so we can scope queries to their calls);
    // null is fine for admin/manager/bypass who don't correspond to a
    // single Veeva rep. See docs/architecture/rls.md.
    veevaUserKey: text("veeva_user_key"),
    effectiveTerritoryIds: text("effective_territory_ids").array(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.userEmail] }),
    repNeedsUserKey: check(
      "tenant_user_rep_needs_user_key",
      sql`${t.role} <> 'rep' OR ${t.veevaUserKey} IS NOT NULL`,
    ),
  }),
);

// Goal — flexible schema supporting any metric × any entity × any period.
// Authoring lives in Postgres (admin UI writes here); a goals_sync notebook
// mirrors to gold.fact_goal in Fabric so analytics queries can join on
// goal_value alongside fact_call/fact_sales.
//
// See docs/product/goals.md and the project memory:
// project_goals_product_thesis.md (the 80/20 framing).
export const goal = pgTable(
  "goal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    metric: goalMetricEnum("metric").notNull(),
    entityType: goalEntityTypeEnum("entity_type").notNull(),
    // The dim key value for the entity (e.g. dim_user.user_key for rep,
    // dim_territory.territory_key for territory). Null when entity_type =
    // 'tenant_wide' — the goal applies across the whole tenant.
    entityId: text("entity_id"),
    periodType: goalPeriodTypeEnum("period_type").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    // Numeric to avoid float drift on goals like $1,234,567.89.
    goalValue: numeric("goal_value", { precision: 18, scale: 4 }).notNull(),
    // Free-text unit ('count', 'usd', 'pct'). Per-metric defaults applied at
    // write time; kept on the row for explicit display + future flexibility.
    goalUnit: text("goal_unit").notNull(),
    source: goalSourceEnum("source").notNull().default("manual"),
    // The recommendation rationale captured at write time, if the goal was
    // accepted from a recommendation. JSON-encoded {historical, peer_median,
    // growth_rate_pct, method}. Null for purely manual goals.
    recommendationContext: text("recommendation_context"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    // One goal per (metric, entity, period). Re-saves overwrite via upsert.
    uniq: unique("goal_unique").on(
      t.tenantId,
      t.metric,
      t.entityType,
      t.entityId,
      t.periodStart,
      t.periodEnd,
    ),
    // entity_id is required EXCEPT for tenant_wide goals (where the entity
    // IS the tenant itself, and entity_id stays null).
    entityIdRequired: check(
      "goal_entity_id_required",
      sql`${t.entityType} = 'tenant_wide' OR ${t.entityId} IS NOT NULL`,
    ),
    // period_end must be on or after period_start.
    periodOrdered: check(
      "goal_period_ordered",
      sql`${t.periodEnd} >= ${t.periodStart}`,
    ),
    // goal_value must be non-negative (a goal of zero is valid for "no
    // expected activity"; negative is always wrong).
    goalValueNonNegative: check(
      "goal_value_non_negative",
      sql`${t.goalValue} >= 0`,
    ),
  }),
);
