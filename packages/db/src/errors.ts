/** A five-character SQLSTATE such as 23505. */
const SQLSTATE = /^[0-9A-Z]{5}$/u;

export interface PgErrorInfo {
  code: string;
  constraint?: string;
  table?: string;
}

/**
 * The Postgres error behind a failed query. Drizzle wraps the driver's error in a
 * `DrizzleQueryError` and keeps the original in `cause`, so look through the chain.
 */
export function pgError(error: unknown): PgErrorInfo | null {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth += 1) {
    const candidate = current as { code?: unknown; constraint?: unknown; table?: unknown };
    if (typeof candidate.code === "string" && SQLSTATE.test(candidate.code)) {
      return {
        code: candidate.code,
        constraint: typeof candidate.constraint === "string" ? candidate.constraint : undefined,
        table: typeof candidate.table === "string" ? candidate.table : undefined,
      };
    }
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** True for a unique-index violation, optionally only for one named constraint or index. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const info = pgError(error);
  return info?.code === "23505" && (constraint === undefined || info.constraint === constraint);
}
