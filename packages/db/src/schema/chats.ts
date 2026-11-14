import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  // biome-ignore lint/suspicious/noDeprecatedImports: only the positional overload is deprecated; this file uses { columns }.
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { GROUP_NAME_MAX } from "@dovetalk/contracts";

import { newId } from "../ids.js";
import { users } from "./users.js";

export const CHAT_TYPES = ["direct", "group"] as const;
export type ChatType = (typeof CHAT_TYPES)[number];

/**
 * A conversation, shared by everyone in it. What differs per person (unread, pin, archive, the
 * point where their history starts) lives on `chat_members`.
 *
 * - `direct_key` is `least(a,b):greatest(a,b)` of the two user ids, so a pair can only ever have
 *   one chat, however the two of them race to open it. Groups have none.
 * - `last_seq` is the sequence number of the newest message. Sending bumps it inside the same
 *   transaction as the insert, which gives every message its place in the chat and serialises
 *   writers per chat and nothing else.
 * - Direct chats have no name and no colour of their own: they take the other person's.
 */
export const chats = pgTable(
  "chats",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    type: text("type").$type<ChatType>().notNull(),
    name: text("name"),
    hue: smallint("hue"),
    directKey: text("direct_key"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("chats_direct_key_key").on(table.directKey),
    check("chats_type", sql`${table.type} in ('direct', 'group')`),
    check(
      "chats_direct_key_matches_type",
      sql`(${table.type} = 'direct') = (${table.directKey} is not null)`,
    ),
    // Written out null by null: a check that comes out NULL passes, so `char_length(null) between
    // 1 and 60` alone would let a nameless group in.
    check(
      "chats_group_has_name_and_hue",
      sql`${table.type} = 'direct' or (${table.name} is not null and char_length(btrim(${table.name})) between 1 and ${sql.raw(String(GROUP_NAME_MAX))} and ${table.hue} is not null and ${table.hue} between 0 and 359)`,
    ),
    check("chats_last_seq_not_negative", sql`${table.lastSeq} >= 0`),
  ],
);

/**
 * One person's place in one chat.
 *
 * - Active means `left_at is null`. Someone removed from a group keeps the row, so what they
 *   already saw is not lost if they are added back, and their other per-person state is reset.
 * - `hidden_at` is "deleted from my list". A new message clears it. `cleared_before_seq` is the
 *   first thing the person cannot see: messages up to and including that number are theirs to
 *   never see again. Clearing and deleting a chat, and joining a group late, all move it.
 * - `unread_count` is a counter, bumped in the transaction that stores a message, and never
 *   computed by counting rows.
 */
export const chatMembers = pgTable(
  "chat_members",
  {
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    unreadCount: integer("unread_count").notNull().default(0),
    archived: boolean("archived").notNull().default(false),
    pinned: boolean("pinned").notNull().default(false),
    muted: boolean("muted").notNull().default(false),
    clearedBeforeSeq: bigint("cleared_before_seq", { mode: "number" }).notNull().default(0),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp("left_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ name: "chat_members_pkey", columns: [table.chatId, table.userId] }),
    // "My chats": the one lookup every chat list starts with.
    index("chat_members_user_id_chat_id_idx").on(table.userId, table.chatId),
    check("chat_members_unread_not_negative", sql`${table.unreadCount} >= 0`),
    check("chat_members_cleared_not_negative", sql`${table.clearedBeforeSeq} >= 0`),
  ],
);

export type ChatRow = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
export type ChatMemberRow = typeof chatMembers.$inferSelect;
export type NewChatMember = typeof chatMembers.$inferInsert;
