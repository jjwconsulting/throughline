import { createDbClient, type DbClient } from "@throughline/db";

const globalForDb = globalThis as unknown as { db?: DbClient };

export const db: DbClient =
  globalForDb.db ??
  createDbClient(process.env.DATABASE_URL ?? "postgresql://invalid-placeholder");

if (process.env.NODE_ENV !== "production") {
  globalForDb.db = db;
}
