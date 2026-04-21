import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
]);

export const mappingKindEnum = pgEnum("mapping_kind", [
  "product",
  "territory",
  "hco_channel",
  "customer_type",
  "custom_grouping",
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
    effectiveTerritoryIds: text("effective_territory_ids").array(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.userEmail] }),
  }),
);
