import { and, asc, desc, eq, gt, inArray, isNull, ne, type SQL, sql } from "drizzle-orm";
import { type AnyPgColumn, alias } from "drizzle-orm/pg-core";

import type { ChatDto } from "@dovetalk/contracts";
import { type Executor, type MessageRow, schema } from "@dovetalk/db";

import { loadDirectory } from "./directory.js";
import { loadMessageViews, type MessageSource, type MessageViewDeps } from "./message-views.js";
import { runQueries } from "./run-queries.js";

const { chatMembers, chats, messageHidden, messages } = schema;

/** The message a reply points at, joined in so a preview costs no extra query. */
export const replied = alias(messages, "replied");
/** The viewer's "delete for me" row for the message a reply points at, if there is one. */
export const repliedHidden = alias(messageHidden, "replied_hidden");

/**
 * True while the viewer has not hidden the message: neither "delete for me", nor sent to them
 * after they blocked the sender (docs/edge-cases.md, #19). `messageId` is the column to test,
 * so the same condition serves a message and the original of a reply.
 */
export const notHiddenFor = (viewerId: string, messageId: AnyPgColumn): SQL =>
  sql`not exists (select 1 from ${messageHidden} where ${messageHidden.messageId} = ${messageId} and ${messageHidden.userId} = ${viewerId})`;

/**
 * The original of a reply, as the viewer may see it, or `null` when they may not: it is older
 * than where their history starts, in another chat, or hidden by them. A preview of such a
 * message reads as a deleted one, as the mock does.
 */
export const visibleOriginal = (
  chatId: string,
  clearedBeforeSeq: number,
  original: MessageRow | null,
  hidden: unknown,
): MessageRow | null =>
  original && original.chatId === chatId && original.seq > clearedBeforeSeq && !hidden
    ? original
    : null;

/**
 * The chats on one viewer's list, projected for them. A fixed number of queries, however many
 * chats there are:
 *
 * 1. the viewer's memberships with each chat and its last visible message (a LATERAL join, so
 *    "the newest message after the point my history starts that I have not hidden" is found
 *    per chat by index);
 * 2. the other active members of those chats;
 * 3. the viewer's contacts, which name everybody;
 * 4. the reactions on the last messages, and 5. their files, loaded together for all of them.
 *
 * The first three run side by side, the last two after them.
 *
 * Pass `only` for a single chat. The order is only stable (newest chat first): the web app sorts.
 */
export async function loadChatViews(
  executor: Executor,
  deps: MessageViewDeps,
  viewerId: string,
  only?: string,
): Promise<ChatDto[]> {
  const onList = and(
    eq(chatMembers.userId, viewerId),
    isNull(chatMembers.leftAt),
    isNull(chatMembers.hiddenAt),
    only ? eq(chatMembers.chatId, only) : undefined,
  );

  const lastMessage = executor
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatMembers.chatId),
        gt(messages.seq, chatMembers.clearedBeforeSeq),
        notHiddenFor(viewerId, messages.id),
      ),
    )
    .orderBy(desc(messages.seq))
    .limit(1)
    .as("last_message");

  const [rows, others, directory] = await runQueries(executor, [
    () =>
      executor
        .select()
        .from(chatMembers)
        .innerJoin(chats, eq(chats.id, chatMembers.chatId))
        .leftJoinLateral(lastMessage, sql`true`)
        .leftJoin(replied, eq(replied.id, lastMessage.replyToId))
        .leftJoin(
          repliedHidden,
          and(eq(repliedHidden.messageId, replied.id), eq(repliedHidden.userId, viewerId)),
        )
        .where(onList)
        .orderBy(desc(chats.createdAt), desc(chats.id)),
    () =>
      executor
        .select({ chatId: chatMembers.chatId, userId: chatMembers.userId })
        .from(chatMembers)
        .where(
          and(
            ne(chatMembers.userId, viewerId),
            isNull(chatMembers.leftAt),
            inArray(
              chatMembers.chatId,
              executor.select({ id: chatMembers.chatId }).from(chatMembers).where(onList),
            ),
          ),
        )
        .orderBy(asc(chatMembers.joinedAt), asc(chatMembers.userId)),
    () => loadDirectory(executor, viewerId),
  ]);

  const othersByChat = new Map<string, string[]>();
  for (const { chatId, userId } of others) {
    const list = othersByChat.get(chatId);
    if (list) {
      list.push(userId);
    } else {
      othersByChat.set(chatId, [userId]);
    }
  }

  const sources: MessageSource[] = [];
  for (const row of rows) {
    const last = row.last_message as MessageRow | null;
    if (last) {
      sources.push({
        message: last,
        original: visibleOriginal(
          last.chatId,
          row.chat_members.clearedBeforeSeq,
          row.replied as MessageRow | null,
          row.replied_hidden,
        ),
      });
    }
  }
  const views = await loadMessageViews(executor, deps, viewerId, sources, directory);
  const lastByChat = new Map(views.map((view) => [view.chatId, view]));

  return rows.map((row) =>
    deps.projector.toChatDto(directory, {
      chat: row.chats,
      member: row.chat_members,
      otherUserIds: othersByChat.get(row.chats.id) ?? [],
      lastMessage: lastByChat.get(row.chats.id) ?? null,
    }),
  );
}
