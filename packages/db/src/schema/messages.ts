import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  // biome-ignore lint/suspicious/noDeprecatedImports: only the positional overload is deprecated; this file uses { columns }.
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import type { MessageKind } from "@dovetalk/contracts";

import { newId } from "../ids.js";
import { attachments } from "./attachments.js";
import { chats } from "./chats.js";
import { users } from "./users.js";

/**
 * What a system message says, as data. The words are made when a viewer reads it, because they
 * differ per person: the one who made the group sees "You created this group", everyone else
 * sees "Imogen created this group" (docs/edge-cases.md, #8). People are user ids here.
 */
export type SystemEvent =
  | { type: "group_created"; actorId: string }
  | { type: "group_renamed"; actorId: string; name: string }
  | { type: "members_added"; actorId: string; targetIds: string[] }
  | { type: "members_removed"; actorId: string; targetIds: string[] };

export const MESSAGE_KINDS = [
  "text",
  "voice",
  "system",
  "image",
  "file",
] as const satisfies readonly MessageKind[];

/**
 * One message. `seq` is its place in its chat: 1, 2, 3, with no gaps from sending, and the
 * paging cursor is built on it, not on timestamps (two messages can share a millisecond).
 *
 * - `sender_id` is null for system messages and only for them.
 * - `client_id` is what the sender's app made up. Together with the sender and chat it is unique,
 *   which is what makes a retried send harmless.
 * - A reply points at its original by id. The preview the reader sees is looked up when the
 *   message is read, so an edit or a delete shows up in it.
 * - `attachment_id` is the file of an image or file message. It is set to null when the file goes
 *   away: deleting a message for everyone, or the attachment's owner leaving. Forwarded copies
 *   share the row of the original's attachment.
 */
export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    seq: bigint("seq", { mode: "number" }).notNull(),
    senderId: uuid("sender_id").references(() => users.id, { onDelete: "cascade" }),
    clientId: text("client_id"),
    kind: text("kind").$type<MessageKind>().notNull(),
    text: text("text"),
    duration: integer("duration"),
    bars: jsonb("bars").$type<number[]>(),
    attachmentId: uuid("attachment_id").references(() => attachments.id, {
      onDelete: "set null",
    }),
    replyToId: uuid("reply_to_id").references((): AnyPgColumn => messages.id, {
      onDelete: "set null",
    }),
    forwarded: boolean("forwarded").notNull().default(false),
    edited: boolean("edited").notNull().default(false),
    deleted: boolean("deleted").notNull().default(false),
    event: jsonb("event").$type<SystemEvent>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // Also the index behind history paging and the "newest message" lookup: both read it backwards.
    uniqueIndex("messages_chat_id_seq_key").on(table.chatId, table.seq),
    uniqueIndex("messages_client_id_key")
      .on(table.chatId, table.senderId, table.clientId)
      .where(sql`${table.clientId} is not null`),
    index("messages_reply_to_id_idx")
      .on(table.replyToId)
      .where(sql`${table.replyToId} is not null`),
    index("messages_sender_id_idx").on(table.senderId),
    // "Does anything still use this file?" runs when a message is deleted and in the orphan sweep.
    index("messages_attachment_id_idx")
      .on(table.attachmentId)
      .where(sql`${table.attachmentId} is not null`),
    check("messages_kind", sql`${table.kind} in ('text', 'voice', 'system', 'image', 'file')`),
    // A system message has an event and no sender; every other message has a sender and no event.
    check(
      "messages_system_has_event_and_no_sender",
      sql`(${table.kind} = 'system') = (${table.senderId} is null) and (${table.kind} = 'system') = (${table.event} is not null)`,
    ),
    check("messages_seq_positive", sql`${table.seq} > 0`),
  ],
);

export type MessageRow = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

/**
 * One person's reaction to a message. A person has at most one per message: reacting with
 * another emoji replaces it, as in the prototype (docs/edge-cases.md, #9). The primary key
 * also serves "all reactions of this message".
 */
export const messageReactions = pgTable(
  "message_reactions",
  {
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    emoji: text("emoji").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "message_reactions_pkey", columns: [table.messageId, table.userId] }),
    index("message_reactions_user_id_idx").on(table.userId),
    check("message_reactions_emoji_length", sql`char_length(${table.emoji}) between 1 and 32`),
  ],
);

/**
 * "Delete for me": messages one person no longer sees. It is also how a message sent to someone
 * who blocked the sender is kept from them for good (docs/edge-cases.md, #19).
 */
export const messageHidden = pgTable(
  "message_hidden",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    messageId: uuid("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "message_hidden_pkey", columns: [table.userId, table.messageId] }),
    index("message_hidden_message_id_idx").on(table.messageId),
  ],
);

export type MessageReactionRow = typeof messageReactions.$inferSelect;
export type NewMessageReaction = typeof messageReactions.$inferInsert;
export type MessageHiddenRow = typeof messageHidden.$inferSelect;
