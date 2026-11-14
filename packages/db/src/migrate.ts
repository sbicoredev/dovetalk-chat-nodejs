import { migrate } from "drizzle-orm/node-postgres/migrator";
import type pg from "pg";

import type { Database } from "./client.js";

/** Where the generated SQL migrations live. */
export const MIGRATIONS_FOLDER = new URL("../drizzle", import.meta.url).pathname;

/** Arbitrary constant. All migrators on one database queue behind the same advisory lock. */
const MIGRATION_LOCK_ID = 7_265_463_001;

/**
 * Applies pending migrations. A session-level advisory lock makes it safe when several
 * instances start at once, because Drizzle's migrator does not lock by itself.
 */
export async function runMigrations(db: Database, pool: pg.Pool): Promise<void> {
  const lockClient = await pool.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    try {
      await lockClient.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]);
    } finally {
      lockClient.release();
    }
  }
}
