import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { DEFAULT_ABOUT, type Preferences } from "@dovetalk/contracts";

import { newId } from "../ids.js";
// biome-ignore lint/suspicious/noImportCycles: users and attachments point at each other (owner, profile photo). Every reference is a lazy arrow function, so neither table is read while the modules load.
import { attachments } from "./attachments.js";

export const DEFAULT_PREFERENCES: Preferences = {
  sounds: true,
  previews: true,
  enterToSend: true,
};

/**
 * Everyone who can appear in a chat: people who signed up, guests, and the shared bots.
 *
 * - Real people have an email and a password. Guests have a generated email and no password.
 *   Bots have neither and can never sign in.
 * - `email` is stored lower case. The check constraint keeps it that way even for raw SQL.
 * - `phone` is what the person typed. `phone_digits` is derived from it by the database, so the
 *   unique index compares numbers regardless of spaces, dashes and brackets. Bot and ghost-contact
 *   numbers live on the owner's contact row, never here (docs/edge-cases.md, #2).
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    email: text("email"),
    passwordHash: text("password_hash"),
    name: text("name").notNull(),
    about: text("about").notNull().default(DEFAULT_ABOUT),
    /**
     * The profile photo: an upload of this person's. Only the id is stored. The URL is signed
     * when the profile is read, so it never goes stale (docs/edge-cases.md, #15).
     */
    avatarAttachmentId: uuid("avatar_attachment_id").references((): AnyPgColumn => attachments.id, {
      onDelete: "set null",
    }),
    hue: smallint("hue").notNull(),
    phone: text("phone"),
    phoneDigits: text("phone_digits").generatedAlwaysAs(
      sql`nullif(regexp_replace(phone, '\\D', '', 'g'), '')`,
    ),
    preferences: jsonb("preferences").$type<Preferences>().notNull().default(DEFAULT_PREFERENCES),
    isBot: boolean("is_bot").notNull().default(false),
    botOnlineDefault: boolean("bot_online_default").notNull().default(false),
    isGuest: boolean("is_guest").notNull().default(false),
    guestExpiresAt: timestamp("guest_expires_at", { withTimezone: true }),
    /**
     * Set only on a "ghost": the bot made for a number somebody added that nobody has registered.
     * It belongs to that one person and goes with them, so cleaning up a guest cleans up their ghosts.
     */
    ghostOwnerId: uuid("ghost_owner_id").references((): AnyPgColumn => users.id, {
      onDelete: "cascade",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("users_email_key").on(table.email),
    uniqueIndex("users_phone_digits_key").on(table.phoneDigits),
    // The cleanup job scans for expired guests. Only guests are indexed.
    index("users_guest_expires_at_idx")
      .on(table.guestExpiresAt)
      .where(sql`${table.guestExpiresAt} is not null`),
    check("users_email_lowercase", sql`${table.email} = lower(${table.email})`),
    check(
      "users_phone_digits_length",
      sql`${table.phoneDigits} is null or char_length(${table.phoneDigits}) between 7 and 15`,
    ),
    check("users_guest_has_expiry", sql`${table.isGuest} = (${table.guestExpiresAt} is not null)`),
    check("users_hue_range", sql`${table.hue} between 0 and 359`),
    // A person who can sign in has both credentials. Guests and bots never do.
    check(
      "users_credentials",
      sql`(${table.isBot} or ${table.isGuest}) or (${table.email} is not null and ${table.passwordHash} is not null)`,
    ),
    index("users_avatar_attachment_id_idx")
      .on(table.avatarAttachmentId)
      .where(sql`${table.avatarAttachmentId} is not null`),
    index("users_ghost_owner_id_idx")
      .on(table.ghostOwnerId)
      .where(sql`${table.ghostOwnerId} is not null`),
    check("users_ghost_is_bot", sql`${table.ghostOwnerId} is null or ${table.isBot}`),
    check("users_not_both_bot_and_guest", sql`not (${table.isBot} and ${table.isGuest})`),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
