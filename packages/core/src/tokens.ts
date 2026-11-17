/** Injection tokens for the shared infrastructure. */
export const CORE_OPTIONS = Symbol("CORE_OPTIONS");
export const DATABASE_HANDLE = Symbol("DATABASE_HANDLE");
/** The Drizzle database. */
export const DRIZZLE = Symbol("DRIZZLE");
/** The underlying pg pool, for raw SQL and health checks. */
export const PG_POOL = Symbol("PG_POOL");
/** A general-purpose Redis connection (presence, throttling, emitter). Not for BullMQ. */
export const REDIS = Symbol("REDIS");
