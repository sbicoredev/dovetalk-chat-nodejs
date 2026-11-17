import { sql } from "drizzle-orm";

import type { Transaction } from "@dovetalk/db";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * True for the canonical text form of a UUID. Ids arrive in URLs and bodies, and Postgres
 * answers a malformed one with an error (22P02) instead of "no rows", which would be a 500.
 * Services check the shape first and treat a malformed id as one that does not exist.
 */
export const isUuid = (value: unknown): value is string =>
  typeof value === "string" && UUID.test(value);

/**
 * The key that makes a pair of people have one direct chat, whichever of them opens it.
 * Both ids are compared as the lower-case text Postgres gives back, so the key never depends
 * on a database collation.
 */
export const directKey = (a: string, b: string): string => (a < b ? `${a}:${b}` : `${b}:${a}`);

/**
 * Takes a lock that lives until the transaction ends and is shared by every caller that uses
 * the same key. It serialises work that cannot be done with a row lock, such as "count this
 * person's pinned chats, then pin one". Must be called inside a transaction: outside one the
 * lock would be released as soon as the statement finished.
 */
export async function advisoryLock(tx: Transaction, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}
