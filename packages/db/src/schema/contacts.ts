import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { newId } from "../ids.js";
import { users } from "./users.js";

/**
 * One person's address book. `contacts.id` is what the API calls `ContactDto.id`, so two people
 * who both know Priya see her under different ids (docs/adr/0003).
 *
 * - Every row points at a real user, a shared bot or a ghost (`linked_user_id`). That is what lets
 *   the same person be shown to each viewer in their own terms.
 * - `name` and `phone` are the owner's address-book values. `about`, `hue` and `avatar_url` are
 *   overrides: while they are null the linked person's live profile shows through.
 * - `saved = false` marks a person the owner shares a chat with but never added, or whose contact
 *   they deleted. The row stays so that person's messages can still show a name.
 * - `phone_digits` is derived, like on `users`, so numbers compare without punctuation. It is
 *   indexed, not unique: the API looks a number up under a per-owner lock instead, because an
 *   unsaved contact copies the other person's number and may collide with a ghost's.
 */
export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    linkedUserId: uuid("linked_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    phone: text("phone"),
    phoneDigits: text("phone_digits").generatedAlwaysAs(
      sql`nullif(regexp_replace(phone, '\\D', '', 'g'), '')`,
    ),
    about: text("about"),
    hue: smallint("hue"),
    avatarUrl: text("avatar_url"),
    blocked: boolean("blocked").notNull().default(false),
    saved: boolean("saved").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("contacts_owner_linked_key").on(table.ownerId, table.linkedUserId),
    // "Who has me in their address book?" (presence and typing go to those people).
    index("contacts_linked_user_id_idx").on(table.linkedUserId),
    index("contacts_owner_phone_digits_idx").on(table.ownerId, table.phoneDigits),
    check("contacts_hue_range", sql`${table.hue} is null or ${table.hue} between 0 and 359`),
    check("contacts_not_self", sql`${table.ownerId} <> ${table.linkedUserId}`),
  ],
);

export type ContactRow = typeof contacts.$inferSelect;
export type NewContact = typeof contacts.$inferInsert;
