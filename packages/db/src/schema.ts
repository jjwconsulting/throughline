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

// Entity an attribute belongs to. Drives whether a tenant_attribute_map
// row's silver-side data lands in silver.hcp_attribute vs silver.hco_attribute.
// See `project_tenant_custom_attributes` memory + docs/architecture/
// tenant-custom-attributes.md.
export const attributeEntityTypeEnum = pgEnum("attribute_entity_type", [
  "hcp",
  "hco",
]);

// Semantic shape of an attribute value. Informs gold-layer parsing
// (decile/score/percentile → numeric; categorical/flag → string) and
// downstream consumption (LLM prompt context, ranking math).
export const attributeTypeEnum = pgEnum("attribute_type", [
  "decile",
  "score",
  "volume",
  "percentile",
  "categorical",
  "flag",
]);

export const tenantUserRoleEnum = pgEnum("tenant_user_role", [
  "admin",
  "manager",
  "rep",
  "bypass",
]);

// Each value names a Fabric notebook (or pipeline) that the web app
// surfaces under /admin/pipelines. Two tiers:
//
// Global (scope='global', tenant_id null) — ops-managed, NOT customer-
// triggerable. Read-only on the health page.
//   - incremental_refresh:   Veeva incremental + SFTP + downstream rebuilds
//   - weekly_full_refresh:   Veeva full ingest + complete rebuild (catches
//                            deletes / late updates incremental misses)
//   - delta_maintenance:     OPTIMIZE + VACUUM across delta tables
//
// Tenant (scope='tenant', tenant_id required) — customer-triggerable from
// the relevant admin surface (mapping_propagate from /admin/mappings).
//   - mapping_propagate:     config_sync + silver_account_xref + gold_fact_sale
export const pipelineKindEnum = pgEnum("pipeline_kind", [
  "mapping_propagate",
  "incremental_refresh",
  "weekly_full_refresh",
  "delta_maintenance",
]);

export const pipelineScopeEnum = pgEnum("pipeline_scope", [
  "global",
  "tenant",
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

// Audit + health-monitor log for all Fabric pipeline runs (manual web
// triggers, scheduled runs, and tenant-onboarding actions). One row per
// run. Populated by:
//   - The web trigger action (start row only; user sees an immediate ack)
//   - The orchestrator notebook itself, via Supabase REST API writeback
//     (start + finish row updates with step_metrics + error)
//
// Scoping:
//   scope='global', tenant_id=null   — Veeva refresh, delta maintenance,
//                                      anything that processes ALL tenants
//                                      in one run
//   scope='tenant', tenant_id=<uuid> — single-tenant work like
//                                      mapping_propagate or future
//                                      tenant_onboard
export const pipelineRun = pgTable("pipeline_run", {
  id: uuid("id").primaryKey().defaultRandom(),
  scope: pipelineScopeEnum("scope").notNull().default("tenant"),
  // Nullable: required when scope='tenant', null when scope='global'.
  // (We don't enforce this with a CHECK constraint to keep the migration
  // simple; loaders + writers handle the convention.)
  tenantId: uuid("tenant_id").references(() => tenant.id, { onDelete: "cascade" }),
  kind: pipelineKindEnum("kind").notNull(),
  // Fabric job instance id returned by the trigger API (location header
  // suffix). Populated when web triggers via REST; null when the
  // orchestrator runs from a Fabric schedule (since no trigger API call
  // happened on our side).
  jobInstanceId: text("job_instance_id"),
  status: pipelineStatusEnum("status").notNull().default("queued"),
  // Per-step metrics from the orchestrator: { "step_name": { "rows": N,
  // "duration_s": X, "status": "ok"|"error" } }. Schema-less so each
  // pipeline can record what's relevant without table changes.
  stepMetrics: text("step_metrics"),
  // Stack trace or error message from a failed step. Plain text so the
  // health page can render verbatim; LLM brief can summarize later.
  error: text("error"),
  // Short human-readable summary, e.g. "OK in 78s across 3 steps".
  message: text("message"),
  // 'admin' / 'bypass' for web triggers, 'schedule' for Fabric scheduler,
  // 'system' for action-triggered (tenant onboarding etc.).
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
    // When the user last dismissed the /dashboard "Since you last
    // logged in" synopsis card. Drives whether to show the card on
    // the next page load: if this timestamp >= the latest successful
    // pipeline_run.finished_at for the tenant, hide the card (they've
    // already seen + dismissed the synopsis for the current data
    // refresh). Null = never dismissed → show on first eligible visit.
    lastDismissedSynopsisAt: timestamp("last_dismissed_synopsis_at", {
      withTimezone: true,
    }),
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

// Tenant-custom HCP/HCO attribute mapping. Declares which bronze
// fields are "attributes" (per-HCP/HCO scoring data — Komodo deciles,
// Clarivate volumes, etc.) and their semantic shape. Read by
// silver_hcp_attribute_build / silver_hco_attribute_build to pivot
// bronze columns into silver.hcp_attribute / silver.hco_attribute
// long-format Delta tables.
//
// Two ingestion paths supported via source_system + bronze_table:
//   - 'veeva' + 'veeva_obj_account__v' → tenant loaded scoring into
//     Veeva account custom fields (e.g., fennec/Komodo)
//   - 'sftp' + 'sftp_<feed_name>' → standalone CSV/file delivery
//     (e.g., Clarivate direct)
//
// Phase 1 ships this config table + admin UI. Phase 2 adds the
// silver/gold notebooks. Phase 3 wires LLM input via the existing
// `predictions` placeholder field on rep-recommendations input
// (per project_llm_input_extensibility memory).
//
// Spec: docs/architecture/tenant-custom-attributes.md.
export const tenantAttributeMap = pgTable(
  "tenant_attribute_map",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    sourceSystem: sourceSystemEnum("source_system").notNull(),
    // Bronze-side reference: which bronze table holds this column.
    // Veeva path: 'veeva_obj_account__v'. SFTP path: e.g.
    // 'sftp_komodo_2024'. The downstream silver build resolves the
    // physical table name via the tenant's bronze schema prefix.
    bronzeTable: text("bronze_table").notNull(),
    bronzeColumn: text("bronze_column").notNull(),
    // Canonical name in our attribute space (admin's choice during
    // setup). Tenants can share canonical names where it makes sense
    // (e.g., 'breast_cancer_decile') so analytics + LLM prompts can
    // reference them stably.
    attributeName: text("attribute_name").notNull(),
    entityType: attributeEntityTypeEnum("entity_type").notNull(),
    attributeType: attributeTypeEnum("attribute_type").notNull(),
    // Source attribution — visible in reports + LLM prompts +
    // audit. e.g. 'komodo_2024_q4', 'clarivate_2024_jan'.
    sourceLabel: text("source_label").notNull(),
    // Optional therapy-area / product / scope tag for analytics
    // grouping. Lets the gold layer + LLM filter by therapy area.
    scopeTag: text("scope_tag"),
    active: boolean("active").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedBy: text("updated_by").notNull(),
  },
  (t) => ({
    // One mapping per (tenant, bronze location). Re-saving the same
    // bronze column for a different attribute_name = update, not
    // duplicate — admins fix typos by re-mapping.
    uniqBronzeLocation: unique(
      "tenant_attribute_map_bronze_location_uniq",
    ).on(t.tenantId, t.sourceSystem, t.bronzeTable, t.bronzeColumn),
  }),
);

// Per-(rep × pipeline_run) cache of the LLM-generated "Suggested
// this week" recommendations on /reps/[user_key]. Cache key keyed
// on the REP being viewed (not the viewer), so manager + admin +
// the rep themselves all see the same recommendations for the
// same rep at the same data snapshot. Body is JSON-stringified
// list of `{ kind, key, label, reason }`.
export const repRecommendationCache = pgTable(
  "rep_recommendation_cache",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    // The rep these recommendations are FOR (dim_user.user_key).
    // Plain text since dim_user lives in Fabric, not Postgres.
    repUserKey: text("rep_user_key").notNull(),
    pipelineRunId: uuid("pipeline_run_id")
      .notNull()
      .references(() => pipelineRun.id, { onDelete: "cascade" }),
    // JSON-stringified list: [{ kind: 'hcp'|'hco', key, label,
    // reason, severity? }].
    body: text("body").notNull(),
    // JSON snapshot of LLM input — debugging + prompt iteration.
    inputSnapshot: text("input_snapshot"),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.tenantId, t.repUserKey, t.pipelineRunId],
    }),
  }),
);

// Per-(user × pipeline_run) cache of the LLM-generated dashboard
// synopsis. Cache key includes pipeline_run_id so a fresh data
// refresh forces a recompute; multiple page loads against the same
// data refresh hit cache and skip the LLM call entirely.
//
// One row per (tenant, user, pipeline_run) — typically 1-2 rows per
// user per day. Old rows naturally age out as pipeline_run cascades
// delete (or via a future cron).
export const synopsisCache = pgTable(
  "synopsis_cache",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    userEmail: text("user_email").notNull(),
    pipelineRunId: uuid("pipeline_run_id")
      .notNull()
      .references(() => pipelineRun.id, { onDelete: "cascade" }),
    // The LLM-generated narration. Plain text — we render as a
    // single paragraph in the UI; bullets / structure can be added
    // later if usage shows it's needed.
    body: text("body").notNull(),
    // JSON snapshot of what we sent the LLM (top movers, signals,
    // attainment shifts). Useful for prompt iteration + debugging
    // bad outputs without re-running the loaders.
    inputSnapshot: text("input_snapshot"),
    generatedAt: timestamp("generated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({
      columns: [t.tenantId, t.userEmail, t.pipelineRunId],
    }),
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
