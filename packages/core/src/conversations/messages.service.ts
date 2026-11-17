import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, gt, isNull, lt, ne, or, sql } from "drizzle-orm";

import {
  type DeleteScope,
  FORWARD_CHATS_MAX,
  MESSAGE_PAGE_MAX,
  MESSAGE_PAGE_SIZE,
  type MessageDto,
  type MessagePage,
  type MessagesQuery,
  type SendMessageInput,
} from "@dovetalk/contracts";
import {
  type ChatRow,
  type Database,
  type Executor,
  isUniqueViolation,
  type MessageRow,
  schema,
  type Transaction,
} from "@dovetalk/db";
import { dovetalkMetrics, withSpan } from "@dovetalk/telemetry";

import { DomainError } from "../errors.js";
import { must } from "../invariant.js";
import { BotReplyScheduler } from "../jobs/bot-reply-scheduler.js";
import { RealtimeEvents } from "../realtime/realtime-events.service.js";
import { AttachmentsService } from "../storage/attachments.service.js";
import { isRasterImage } from "../storage/file-info.js";
import { DRIZZLE } from "../tokens.js";
import { notHiddenFor, replied, repliedHidden, visibleOriginal } from "./chat-views.js";
import { isUuid } from "./ids.js";
import { findVisibleChat, findVisibleMessage } from "./membership.js";
import {
  caption,
  checkContent,
  requireClientId,
  requireEmoji,
  requireText,
} from "./message-content.js";
import { MessageStore } from "./message-store.js";
import { loadMessageViews, type MessageSource } from "./message-views.js";
import { Projector } from "./projector.js";

const {
  attachments: attachmentRows,
  chatMembers,
  contacts,
  messageHidden,
  messageReactions,
  messages,
  users,
} = schema;

/** `created` is false when the send was a replay of one already stored. */
export interface SendResult {
  created: boolean;
  message: MessageDto;
}

const attachmentNotFound = () =>
  new DomainError("ATTACHMENT_NOT_FOUND", "That attachment wasn't found. Upload it again.");

const invalidCursor = () =>
  new DomainError("INVALID_CURSOR", "That page can't be loaded. Refresh the chat.");

/**
 * Messages, as one viewer sees them: history, and send, edit, delete, react and forward on top
 * of `MessageStore`.
 */
@Injectable()
export class MessagesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(Projector) private readonly projector: Projector,
    @Inject(MessageStore) private readonly store: MessageStore,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
    @Inject(RealtimeEvents) private readonly events: RealtimeEvents,
    @Inject(BotReplyScheduler) private readonly botReplies: BotReplyScheduler,
  ) {}

  /**
   * One page of history, newest page first and each page oldest first, like the mock. `before` is
   * the cursor from the previous page: the id of that page's oldest message. History starts at the
   * point the viewer last cleared or joined the chat, so older messages are never returned, and
   * what the viewer deleted for themselves is left out.
   */
  async page(viewerId: string, chatId: string, query: MessagesQuery = {}): Promise<MessagePage> {
    const { member } = await findVisibleChat(this.db, viewerId, chatId);
    const limit = Math.min(
      Math.max(Math.trunc(query.limit ?? MESSAGE_PAGE_SIZE), 1),
      MESSAGE_PAGE_MAX,
    );

    let beforeSeq: number | undefined;
    if (query.before) {
      if (!isUuid(query.before)) {
        throw invalidCursor();
      }
      // The cursor may name a message the viewer has since hidden: it is still a place in the chat.
      const [anchor] = await this.db
        .select({ seq: messages.seq })
        .from(messages)
        .where(and(eq(messages.id, query.before), eq(messages.chatId, chatId)))
        .limit(1);
      // An id from another chat reads the same as one that does not exist.
      if (!anchor) {
        throw invalidCursor();
      }
      beforeSeq = anchor.seq;
    }

    const rows = await this.db
      .select({ message: messages, reply: replied, replyHidden: repliedHidden.messageId })
      .from(messages)
      .leftJoin(replied, eq(replied.id, messages.replyToId))
      .leftJoin(
        repliedHidden,
        and(eq(repliedHidden.messageId, replied.id), eq(repliedHidden.userId, viewerId)),
      )
      .where(
        and(
          eq(messages.chatId, chatId),
          gt(messages.seq, member.clearedBeforeSeq),
          notHiddenFor(viewerId, messages.id),
          beforeSeq === undefined ? undefined : lt(messages.seq, beforeSeq),
        ),
      )
      .orderBy(desc(messages.seq))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).reverse();

    const items = await loadMessageViews(
      this.db,
      { projector: this.projector, attachments: this.attachments },
      viewerId,
      page.map(({ message, reply, replyHidden }) => ({
        message,
        original: visibleOriginal(
          chatId,
          member.clearedBeforeSeq,
          reply as MessageRow | null,
          replyHidden,
        ),
      })),
    );

    return { items, nextCursor: hasMore && page[0] ? page[0].message.id : null };
  }

  // ---- writing --------------------------------------------------------------

  /**
   * Sends a message as the user `senderId`: a person through the API, a bot through the worker.
   * Checks run in the mock's order: the chat is visible (404), the `clientId` was not seen before
   * (a replay returns the stored message and changes nothing), the sender has not blocked the
   * contact (403), then the content (422), the attachment and the reply target.
   *
   * Everything happens in one transaction under a lock on the chat row, so two sends of one
   * `clientId` at once are serialised and the second sees the first (the unique index is only a
   * backstop). A replay takes no place in the chat's order and counts no unread.
   * A message that was `created` is announced to the chat's members after the commit, and a bot
   * in the chat is set to answer it (`BotReplyScheduler`: only for a person's message, and only
   * where bot replies are switched on). A replay does neither: the first send already did.
   */
  async send(senderId: string, chatId: string, input: SendMessageInput): Promise<SendResult> {
    // One span for the whole send, so a trace shows the transaction as its child and, after it,
    // the fan-out and the bot job it set going. The ids are span attributes, not metric labels.
    return withSpan(
      "message.send",
      { attributes: { "chat.id": chatId, "message.kind": input.kind } },
      async (span) => {
        const result = await this.sendOnce(senderId, chatId, input);
        span.setAttributes({
          "message.id": result.message.id,
          "message.replayed": !result.created,
        });
        if (result.created) {
          dovetalkMetrics().messagesSent.add(1, { kind: input.kind });
          this.events.messageCreated(chatId, result.message.id);
          this.botReplies.messageSent(chatId, result.message.id, senderId);
        }
        return result;
      },
    );
  }

  private async sendOnce(
    senderId: string,
    chatId: string,
    input: SendMessageInput,
  ): Promise<SendResult> {
    try {
      return await this.db.transaction((tx) => this.sendIn(tx, senderId, chatId, input));
    } catch (error) {
      if (!isUniqueViolation(error, "messages_client_id_key")) {
        throw error;
      }
      // Lost a race the lock should have prevented: the other send won, so this is its replay.
      const { member } = await findVisibleChat(this.db, senderId, chatId);
      const [row] = await this.db
        .select()
        .from(messages)
        .where(
          and(
            eq(messages.chatId, chatId),
            eq(messages.senderId, senderId),
            eq(messages.clientId, input.clientId),
          ),
        )
        .limit(1);
      if (!row) {
        throw error;
      }
      return {
        message: await this.viewOne(this.db, senderId, row, member.clearedBeforeSeq),
        created: false,
      };
    }
  }

  private async sendIn(
    tx: Transaction,
    senderId: string,
    chatId: string,
    input: SendMessageInput,
  ): Promise<SendResult> {
    const { chat, member } = await findVisibleChat(tx, senderId, chatId, { lock: true });
    const clientId = requireClientId(input.clientId);

    const [existing] = await tx
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.chatId, chat.id),
          eq(messages.senderId, senderId),
          eq(messages.clientId, clientId),
        ),
      )
      .limit(1);
    if (existing) {
      return {
        message: await this.viewOne(tx, senderId, existing, member.clearedBeforeSeq),
        created: false,
      };
    }

    const blocks = chat.type === "direct" ? await this.blocks(tx, chat.id, senderId) : NO_BLOCKS;
    if (blocks.senderBlocked) {
      throw new DomainError("CONTACT_BLOCKED", "Unblock this contact to send messages.");
    }
    const content = checkContent(input);
    const file = content.needsAttachment
      ? await this.claimAttachment(tx, senderId, input.attachmentId, input.kind)
      : null;
    let original: MessageRow | null = null;
    if (input.replyToId !== undefined && input.replyToId !== null) {
      original = await this.findOriginal(
        tx,
        senderId,
        chat.id,
        member.clearedBeforeSeq,
        input.replyToId,
      );
      if (!original) {
        throw new DomainError("VALIDATION_ERROR", ["The message you replied to no longer exists."]);
      }
    }

    const row = await this.store.append(tx, {
      chatId: chat.id,
      senderId,
      clientId,
      kind: input.kind,
      text: content.text,
      duration: content.duration,
      bars: content.bars,
      attachmentId: file?.id ?? null,
      replyToId: original?.id ?? null,
    });
    await this.deliver(tx, chat, row, senderId, blocks.blockedBy);
    const [message] = await this.views(tx, senderId, [{ message: row, original }], {
      justCreated: true,
    });
    return { message: must(message, "the sent message"), created: true };
  }

  /**
   * Changes the text of the viewer's own text message, or the caption of their picture or file.
   * Order: visible (404), theirs (403: a system message has no author, so it is 403 too),
   * editable (422), then the text.
   */
  async edit(viewerId: string, messageId: string, text: string): Promise<MessageDto> {
    const edited = await this.db.transaction(async (tx) => {
      const { message, member } = await findVisibleMessage(tx, viewerId, messageId, { lock: true });
      if (message.senderId !== viewerId) {
        throw new DomainError("FORBIDDEN", "You can only edit your own messages.");
      }
      if (message.deleted || message.kind === "voice" || message.kind === "system") {
        throw new DomainError("VALIDATION_ERROR", ["This message can't be edited."]);
      }
      const next = message.kind === "text" ? requireText(text) : caption(text);
      const [row] = await tx
        .update(messages)
        .set({ text: next, edited: true })
        .where(eq(messages.id, message.id))
        .returning();
      return this.viewOne(tx, viewerId, must(row, "the edited message"), member.clearedBeforeSeq);
    });
    this.events.messageUpdated(edited.chatId, edited.id);
    return edited;
  }

  /**
   * Deletes a message for the viewer (`me`) or for everybody (`everyone`, the sender only). A
   * missing or unknown `scope` is a 422: the destructive choice is never the default.
   * Deleting for everyone keeps the row as a tombstone and lets the file go once nothing else
   * (a forwarded copy, a profile photo) uses it.
   */
  async remove(viewerId: string, messageId: string, scope: DeleteScope): Promise<void> {
    if (scope !== "me" && scope !== "everyone") {
      throw new DomainError("VALIDATION_ERROR", ['scope must be "me" or "everyone".']);
    }
    const { released, notify } = await this.db.transaction(async (tx) => {
      const { message } = await findVisibleMessage(tx, viewerId, messageId, { lock: true });
      if (scope === "me") {
        await tx
          .insert(messageHidden)
          .values({ userId: viewerId, messageId: message.id })
          .onConflictDoNothing();
        return { released: null, notify: { chatId: message.chatId, scope } as const };
      }
      if (message.senderId !== viewerId) {
        throw new DomainError("FORBIDDEN", "You can only delete your own messages for everyone.");
      }
      if (message.deleted) {
        return { released: null, notify: null };
      }
      await tx.delete(messageReactions).where(eq(messageReactions.messageId, message.id));
      await tx
        .update(messages)
        .set({
          deleted: true,
          text: null,
          attachmentId: null,
          duration: null,
          bars: null,
          forwarded: false,
          edited: false,
        })
        .where(eq(messages.id, message.id));
      return {
        released: message.attachmentId,
        notify: { chatId: message.chatId, scope, messageId: message.id } as const,
      };
    });
    if (notify?.scope === "everyone") {
      this.events.messageUpdated(notify.chatId, notify.messageId);
    } else if (notify) {
      // Hidden for the viewer alone: their other devices see the chat's last message change.
      this.events.chatChanged(notify.chatId, [viewerId]);
    }
    if (released) {
      await this.attachments.releaseUnused([released]);
    }
  }

  /**
   * One reaction per person per message, as in the prototype: the same emoji again takes it
   * back, a different one replaces it. Returns the message as the viewer now sees it.
   */
  async toggleReaction(viewerId: string, messageId: string, emoji: string): Promise<MessageDto> {
    const wanted = requireEmoji(emoji);
    const updated = await this.db.transaction(async (tx) => {
      const { message, member } = await findVisibleMessage(tx, viewerId, messageId, { lock: true });
      if (message.deleted || message.kind === "system") {
        throw new DomainError("VALIDATION_ERROR", ["You can't react to this message."]);
      }
      const [current] = await tx
        .select({ emoji: messageReactions.emoji })
        .from(messageReactions)
        .where(
          and(eq(messageReactions.messageId, message.id), eq(messageReactions.userId, viewerId)),
        );
      if (current?.emoji === wanted) {
        await tx
          .delete(messageReactions)
          .where(
            and(eq(messageReactions.messageId, message.id), eq(messageReactions.userId, viewerId)),
          );
      } else {
        await tx
          .insert(messageReactions)
          .values({ messageId: message.id, userId: viewerId, emoji: wanted })
          .onConflictDoUpdate({
            target: [messageReactions.messageId, messageReactions.userId],
            // A replaced reaction goes to the back of the line, as in the mock.
            set: { emoji: wanted, createdAt: sql`clock_timestamp()` },
          });
      }
      return this.viewOne(tx, viewerId, message, member.clearedBeforeSeq);
    });
    this.events.messageUpdated(updated.chatId, updated.id);
    return updated;
  }

  /**
   * Copies a message into one or more of the viewer's chats, as theirs and marked `forwarded`.
   * Returns the copies in the order of `chatIds`, which can be fewer than asked for: a direct
   * chat with somebody the viewer blocked is skipped silently, as the mock does. A chat the
   * viewer cannot see fails the whole call with a 404 and nothing is written. The copy shares
   * the original's file, and drops its reply, reactions and `clientId`.
   */
  async forward(
    viewerId: string,
    messageId: string,
    chatIds: readonly string[],
  ): Promise<MessageDto[]> {
    if (!Array.isArray(chatIds) || chatIds.some((id) => typeof id !== "string")) {
      throw new DomainError("VALIDATION_ERROR", ["chatIds must be a list of chat ids."]);
    }
    const targets = [...new Set(chatIds)];
    if (targets.length > FORWARD_CHATS_MAX) {
      throw new DomainError("VALIDATION_ERROR", [
        `You can forward to at most ${FORWARD_CHATS_MAX} chats at once.`,
      ]);
    }

    const { views, made } = await this.db.transaction(async (tx) => {
      const { message: source } = await findVisibleMessage(tx, viewerId, messageId);
      if (source.deleted || source.kind === "system") {
        throw new DomainError("VALIDATION_ERROR", ["This message can't be forwarded."]);
      }

      // Lock in id order, so two forwards into the same chats cannot wait on each other.
      const locked = new Map<string, ChatRow>();
      for (const id of [...targets].sort(byCodeUnit)) {
        // biome-ignore lint/performance/noAwaitInLoops: the locks must be taken one by one, in id order, on one connection.
        const { chat } = await findVisibleChat(tx, viewerId, id, { lock: true });
        locked.set(id, chat);
      }

      const copies: MessageRow[] = [];
      for (const id of targets) {
        // biome-ignore lint/performance/noAwaitInLoops: one transaction connection runs one query at a time, and the copies must be written in the order given.
        const row = await this.forwardInto(
          tx,
          viewerId,
          source,
          must(locked.get(id), "a locked chat"),
        );
        if (row) {
          copies.push(row);
        }
      }
      return {
        made: copies,
        views: await this.views(
          tx,
          viewerId,
          copies.map((message) => ({ message, original: null })),
        ),
      };
    });
    for (const row of made) {
      dovetalkMetrics().messagesSent.add(1, { kind: row.kind });
      this.events.messageCreated(row.chatId, row.id);
    }
    return views;
  }

  /** One copy of a forwarded message, or `null` when the viewer has blocked who is on the other end. */
  private async forwardInto(
    tx: Transaction,
    viewerId: string,
    source: MessageRow,
    chat: ChatRow,
  ): Promise<MessageRow | null> {
    const blocks = chat.type === "direct" ? await this.blocks(tx, chat.id, viewerId) : NO_BLOCKS;
    if (blocks.senderBlocked) {
      return null;
    }
    const row = await this.store.append(tx, {
      chatId: chat.id,
      senderId: viewerId,
      kind: source.kind,
      text: source.text,
      duration: source.duration,
      bars: source.bars,
      attachmentId: source.attachmentId,
      forwarded: true,
    });
    await this.deliver(tx, chat, row, viewerId, blocks.blockedBy);
    return row;
  }

  // ---- helpers --------------------------------------------------------------

  private views(
    executor: Executor,
    viewerId: string,
    sources: readonly MessageSource[],
    options?: { justCreated?: boolean },
  ) {
    return loadMessageViews(
      executor,
      { projector: this.projector, attachments: this.attachments },
      viewerId,
      sources,
      undefined,
      options,
    );
  }

  /** One stored message as the viewer sees it, with the original of a reply when they can see it. */
  private async viewOne(
    executor: Executor,
    viewerId: string,
    row: MessageRow,
    clearedBeforeSeq: number,
  ): Promise<MessageDto> {
    const original = row.replyToId
      ? await this.findOriginal(executor, viewerId, row.chatId, clearedBeforeSeq, row.replyToId)
      : null;
    const [message] = await this.views(executor, viewerId, [{ message: row, original }]);
    return must(message, "the projected message");
  }

  /**
   * The message `replyToId` names, if it is in this chat, newer than where the viewer's history
   * starts and not hidden by them. A deleted message (a tombstone) can still be replied to.
   */
  private async findOriginal(
    executor: Executor,
    viewerId: string,
    chatId: string,
    clearedBeforeSeq: number,
    replyToId: string,
  ): Promise<MessageRow | null> {
    if (!isUuid(replyToId)) {
      return null;
    }
    const [row] = await executor
      .select()
      .from(messages)
      .where(
        and(
          eq(messages.id, replyToId),
          eq(messages.chatId, chatId),
          gt(messages.seq, clearedBeforeSeq),
          notHiddenFor(viewerId, messages.id),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Takes an upload for a message. It must be the sender's, and not already used by a message or
   * a profile photo: the mock consumes an upload on first use, and so does this. Locked, so two
   * sends cannot both take it; the "is it used" lookups are separate statements, which is what
   * lets the one that waited for the lock see what the other committed.
   */
  private async claimAttachment(
    tx: Transaction,
    senderId: string,
    attachmentId: unknown,
    kind: SendMessageInput["kind"],
  ) {
    if (!isUuid(attachmentId)) {
      throw attachmentNotFound();
    }
    const [file] = await tx
      .select()
      .from(attachmentRows)
      .where(and(eq(attachmentRows.id, attachmentId), eq(attachmentRows.ownerId, senderId)))
      .for("update");
    if (!file) {
      throw attachmentNotFound();
    }
    const [inMessage] = await tx
      .select({ id: messages.id })
      .from(messages)
      .where(eq(messages.attachmentId, file.id))
      .limit(1);
    const [asPhoto] = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.avatarAttachmentId, file.id))
      .limit(1);
    if (inMessage || asPhoto) {
      throw attachmentNotFound();
    }
    if (kind === "image" && !isRasterImage(file.mime)) {
      throw new DomainError("VALIDATION_ERROR", ["That file isn't an image."]);
    }
    return file;
  }

  /**
   * In a direct chat: has the sender blocked the other person (the send is refused), and has the
   * other person blocked the sender (the send is stored but never reaches them).
   */
  private async blocks(tx: Transaction, chatId: string, senderId: string): Promise<Blocks> {
    const rows = await tx
      .select({ ownerId: contacts.ownerId })
      .from(contacts)
      .innerJoin(chatMembers, and(eq(chatMembers.chatId, chatId), ne(chatMembers.userId, senderId)))
      .where(
        and(
          eq(contacts.blocked, true),
          or(
            and(eq(contacts.ownerId, senderId), eq(contacts.linkedUserId, chatMembers.userId)),
            and(eq(contacts.ownerId, chatMembers.userId), eq(contacts.linkedUserId, senderId)),
          ),
        ),
      );
    return {
      senderBlocked: rows.some((row) => row.ownerId === senderId),
      blockedBy: rows.find((row) => row.ownerId !== senderId)?.ownerId ?? null,
    };
  }

  /**
   * Makes a stored message reach the other members: one more unread for each of them, and a chat
   * they had deleted comes back (what they cleared stays cleared). If the one person on the
   * other end has blocked the sender, none of that happens and the message is hidden from them
   * for good, so it does not appear if they unblock (docs/edge-cases.md, #19).
   */
  private async deliver(
    tx: Transaction,
    chat: ChatRow,
    row: MessageRow,
    senderId: string,
    blockedBy: string | null,
  ): Promise<void> {
    if (blockedBy) {
      await tx
        .insert(messageHidden)
        .values({ userId: blockedBy, messageId: row.id })
        .onConflictDoNothing();
      return;
    }
    await tx
      .update(chatMembers)
      .set({ unreadCount: sql`${chatMembers.unreadCount} + 1`, hiddenAt: null })
      .where(
        and(
          eq(chatMembers.chatId, chat.id),
          ne(chatMembers.userId, senderId),
          isNull(chatMembers.leftAt),
        ),
      );
  }
}

interface Blocks {
  /** The person this sender is writing to has blocked them. */
  blockedBy: string | null;
  /** The sender has blocked the person they are writing to. */
  senderBlocked: boolean;
}

/** A fixed order for ids, whatever the database's collation. */
const byCodeUnit = (a: string, b: string): number => {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
};

const NO_BLOCKS: Blocks = { senderBlocked: false, blockedBy: null };
