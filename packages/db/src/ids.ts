import { v7 } from "uuid";

/**
 * A new primary key. UUIDv7 puts the creation time in the first bits, so ids sort in creation
 * order and index inserts stay append-mostly. It is made here, not by the database, because
 * Postgres only gained `uuidv7()` in version 18 and we also run on 16.
 */
export const newId = (): string => v7();
