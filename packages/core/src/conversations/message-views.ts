import { asc, inArray } from "drizzle-orm";

import type { MessageDto } from "@dovetalk/contracts";
import { type Executor, type MessageRow, schema } from "@dovetalk/db";

import type { AttachmentsService } from "../storage/attachments.service.js";
import { loadDirectory } from "./directory.js";
import type { Projector, ReactionSource, ViewerDirectory } from "./projector.js";

const { messageReactions } = schema;

/** A message and the message it replies to, when the viewer can see that one. */
export interface MessageSource {
  message: MessageRow;
  original: MessageRow | null;
}

/** The services the loader needs. Passed in so a free function can be used in a transaction. */
export interface MessageViewDeps {
  attachments: AttachmentsService;
  projector: Projector;
}

/** Every user a message names: its sender and, for a system message, the people in its event. */
export function collectPeople(into: Set<string>, message: MessageRow): void {
  if (message.senderId) {
    into.add(message.senderId);
  }
  const { event } = message;
  if (!event) {
    return;
  }
  into.add(event.actorId);
  if ("targetIds" in event) {
    for (const id of event.targetIds) {
      into.add(id);
    }
  }
}

/** The reactions of these messages, in the order they were made in, which is how they are shown. */
async function loadReactions(
  executor: Executor,
  live: readonly MessageSource[],
): Promise<{ messageId: string; emoji: string; userId: string }[]> {
  if (live.length === 0) {
    return [];
  }
  return await executor
    .select({
      messageId: messageReactions.messageId,
      emoji: messageReactions.emoji,
      userId: messageReactions.userId,
    })
    .from(messageReactions)
    .where(
      inArray(
        messageReactions.messageId,
        live.map(({ message }) => message.id),
      ),
    )
    .orderBy(asc(messageReactions.createdAt), asc(messageReactions.userId));
}

/**
 * Turns message rows into the DTOs one viewer sees. Two queries, however many messages: the
 * reactions of all of them, and the files of all of them (and of the messages they reply to,
 * whose names show in the reply preview). Pass `directory` when the caller already has the
 * viewer's whole address book (the chat list); otherwise only the people these messages name
 * are loaded.
 *
 * `justCreated` says the messages were inserted by the caller's own transaction, which has not
 * committed: nobody else can see them yet, so nobody has reacted, and the reactions query is
 * skipped. That is one of the SQL round trips of every send.
 *
 * The queries run one after another: this is also called inside transactions, where one
 * connection cannot run two at once.
 */
export async function loadMessageViews(
  executor: Executor,
  deps: MessageViewDeps,
  viewerId: string,
  sources: readonly MessageSource[],
  directory?: ViewerDirectory,
  options: { justCreated?: boolean } = {},
): Promise<MessageDto[]> {
  if (sources.length === 0) {
    return [];
  }
  const live = options.justCreated ? [] : sources.filter(({ message }) => !message.deleted);

  const reactions = await loadReactions(executor, live);
  const reactionsOf = new Map<string, ReactionSource[]>();
  for (const { messageId, emoji, userId } of reactions) {
    const list = reactionsOf.get(messageId);
    if (list) {
      list.push({ emoji, userId });
    } else {
      reactionsOf.set(messageId, [{ emoji, userId }]);
    }
  }

  const fileIds = new Set<string>();
  for (const { message, original } of sources) {
    if (message.attachmentId) {
      fileIds.add(message.attachmentId);
    }
    if (original?.attachmentId && !original.deleted) {
      fileIds.add(original.attachmentId);
    }
  }
  const files = await deps.attachments.rows(executor, fileIds);
  const signed = await deps.attachments.sign(
    sources.flatMap(({ message }) => {
      const row = message.attachmentId ? files.get(message.attachmentId) : undefined;
      return row ? [row] : [];
    }),
  );

  let people = directory;
  if (!people) {
    const named = new Set<string>();
    for (const { message, original } of sources) {
      collectPeople(named, message);
      if (original) {
        collectPeople(named, original);
      }
    }
    for (const { userId } of reactions) {
      named.add(userId);
    }
    people = await loadDirectory(executor, viewerId, [...named]);
  }

  return sources.map(({ message, original }) =>
    deps.projector.toMessageDto(people, message, original, {
      attachment: message.attachmentId ? (signed.get(message.attachmentId) ?? null) : null,
      reactions: reactionsOf.get(message.id) ?? [],
      replyFileName: original?.attachmentId
        ? (files.get(original.attachmentId)?.name ?? null)
        : null,
    }),
  );
}
