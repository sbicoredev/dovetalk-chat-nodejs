import { and, eq, gt, isNull, sql } from "drizzle-orm";

import {
  type ChatMemberRow,
  type ChatRow,
  type Executor,
  type MessageRow,
  schema,
  type Transaction,
} from "@dovetalk/db";

import { DomainError } from "../errors.js";
import { isUuid } from "./ids.js";

const { chatMembers, chats, messageHidden, messages } = schema;

/** Everything about a chat that is the person's own and starts over when it leaves their list. */
export const RESET_FLAGS = {
  unreadCount: 0,
  pinned: false,
  archived: false,
  muted: false,
} as const;

/**
 * Takes a chat off one person's list and ends their history there, so the chat comes back
 * empty and fresh if it ever returns. Deleting a chat and deleting a contact both do this.
 * It does nothing to a chat that is already hidden. Returns true when the chat was on the
 * person's list and now is not, so the caller knows whether anything changed for them.
 */
export async function hideChat(tx: Transaction, userId: string, chatId: string): Promise<boolean> {
  const hidden = await tx
    .update(chatMembers)
    .set({
      hiddenAt: sql`now()`,
      clearedBeforeSeq: sql`(select last_seq from chats where id = ${chatId})`,
      ...RESET_FLAGS,
    })
    .where(
      and(
        eq(chatMembers.chatId, chatId),
        eq(chatMembers.userId, userId),
        isNull(chatMembers.hiddenAt),
      ),
    )
    .returning({ chatId: chatMembers.chatId });
  return hidden.length > 0;
}

const chatNotFound = () => new DomainError("CHAT_NOT_FOUND", "This chat no longer exists.");

/**
 * The chat and the viewer's own membership of it, or `CHAT_NOT_FOUND`. A chat is "there" for a
 * person only while they are an active member and have not deleted it from their list, so a
 * chat that is not theirs, one they left, one they deleted and one that does not exist all
 * look the same: 404, never 403, so the answer reveals nothing about other people's chats.
 * Pass `lock` to take a row lock on the chat for the rest of the transaction (group changes).
 */
export async function findVisibleChat(
  executor: Executor,
  viewerId: string,
  chatId: string,
  options: { lock?: boolean } = {},
): Promise<{ chat: ChatRow; member: ChatMemberRow }> {
  if (!isUuid(chatId)) {
    throw chatNotFound();
  }
  const query = executor
    .select({ chat: chats, member: chatMembers })
    .from(chatMembers)
    .innerJoin(chats, eq(chats.id, chatMembers.chatId))
    .where(
      and(
        eq(chatMembers.chatId, chatId),
        eq(chatMembers.userId, viewerId),
        isNull(chatMembers.leftAt),
        isNull(chatMembers.hiddenAt),
      ),
    )
    .limit(1);
  const [row] = await (options.lock ? query.for("update", { of: chats }) : query);
  if (!row) {
    throw chatNotFound();
  }
  return row;
}

const messageNotFound = () =>
  new DomainError("MESSAGE_NOT_FOUND", "This message no longer exists.");

/**
 * A message the viewer can see, with its chat and their membership of it, or `MESSAGE_NOT_FOUND`.
 * A message is "there" for a person while the chat is (active member, not deleted from their
 * list), it is newer than the point where their history starts, and they have not deleted it
 * for themselves. Anything else, including a malformed id or somebody else's chat, is the same
 * 404, never 403 (docs/edge-cases.md, #52). Pass `lock` to hold a row lock on the message until
 * the transaction ends, so edits, deletes and reactions on one message cannot interleave.
 */
export async function findVisibleMessage(
  executor: Executor,
  viewerId: string,
  messageId: string,
  options: { lock?: boolean } = {},
): Promise<{ chat: ChatRow; member: ChatMemberRow; message: MessageRow }> {
  if (!isUuid(messageId)) {
    throw messageNotFound();
  }
  const query = executor
    .select({ message: messages, chat: chats, member: chatMembers })
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .innerJoin(
      chatMembers,
      and(eq(chatMembers.chatId, messages.chatId), eq(chatMembers.userId, viewerId)),
    )
    .where(
      and(
        eq(messages.id, messageId),
        isNull(chatMembers.leftAt),
        isNull(chatMembers.hiddenAt),
        gt(messages.seq, chatMembers.clearedBeforeSeq),
        sql`not exists (select 1 from ${messageHidden} where ${messageHidden.messageId} = ${messages.id} and ${messageHidden.userId} = ${viewerId})`,
      ),
    )
    .limit(1);
  const [row] = await (options.lock ? query.for("update", { of: messages }) : query);
  if (!row) {
    throw messageNotFound();
  }
  return row;
}
