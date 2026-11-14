import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { newId } from "../ids.js";
// biome-ignore lint/suspicious/noImportCycles: users and attachments point at each other (owner, profile photo). Every reference is a lazy arrow function, so neither table is read while the modules load.
import { users } from "./users.js";

/**
 * A file somebody uploaded. The bytes live in object storage under `storage_key`; this row is
 * what the API knows about them.
 *
 * Who points at it decides how long it lives (docs/edge-cases.md, #13 and #14):
 * - a message (`messages.attachment_id`), which a forward shares with the original;
 * - a profile photo (`users.avatar_attachment_id`).
 * An attachment nothing points at for 24 hours is an orphan, and the cleanup job removes it.
 *
 * - `mime` is what the server decided the file is (sniffed from its bytes), not what the client
 *   claimed. `width` and `height` are the client's word and only for display.
 * - The URL the API shows is never stored: it is signed when the DTO is made, so it cannot
 *   expire inside a saved row.
 */
export const attachments = pgTable(
  "attachments",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    storageKey: text("storage_key").notNull(),
    name: text("name").notNull(),
    size: integer("size").notNull(),
    mime: text("mime").notNull(),
    width: integer("width"),
    height: integer("height"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("attachments_storage_key_key").on(table.storageKey),
    index("attachments_owner_id_idx").on(table.ownerId),
    // The orphan sweep reads the oldest rows first.
    index("attachments_created_at_idx").on(table.createdAt),
    check("attachments_size_positive", sql`${table.size} > 0`),
    check(
      "attachments_dimensions_positive",
      sql`(${table.width} is null or ${table.width} > 0) and (${table.height} is null or ${table.height} > 0)`,
    ),
  ],
);

export type AttachmentRow = typeof attachments.$inferSelect;
export type NewAttachment = typeof attachments.$inferInsert;
