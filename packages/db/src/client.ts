import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";

import * as schema from "./schema/index.js";

export interface DatabaseOptions {
  /** Shown in pg_stat_activity so connections can be traced to a service. */
  applicationName?: string;
  /** Give up waiting for a free connection after this long. */
  connectionTimeoutMs?: number;
  /** Called when an idle connection fails, for example when Postgres restarts. */
  onPoolError?: (error: Error) => void;
  /** Largest number of connections this process opens. Keep it small and scale instances instead. */
  poolMax?: number;
  /** Abort any single statement that runs longer than this. 0 turns it off. */
  statementTimeoutMs?: number;
  url: string;
}

export type Database = NodePgDatabase<typeof schema>;
/** What a callback to `db.transaction()` receives. */
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Either one. Service methods take this so callers can run them inside their own transaction. */
export type Executor = Database | Transaction;

export interface DatabaseHandle {
  /** Waits for checked-out connections to come back, then closes the pool. Safe to call twice. */
  close: () => Promise<void>;
  db: Database;
  pool: pg.Pool;
}

export function createDatabase(options: DatabaseOptions): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString: options.url,
    max: options.poolMax ?? 10,
    application_name: options.applicationName ?? "dovetalk",
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5000,
    idleTimeoutMillis: 30_000,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
    allowExitOnIdle: false,
  });

  // Without a listener, one dropped idle connection would crash the whole process.
  pool.on("error", (error) => options.onPoolError?.(error));

  const db = drizzle({ client: pool, schema });
  let closing: Promise<void> | null = null;

  return {
    db,
    pool,
    close() {
      closing ??= pool.end();
      return closing;
    },
  };
}
