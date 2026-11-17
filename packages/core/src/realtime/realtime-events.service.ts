import { type BeforeApplicationShutdown, Inject, Injectable, Logger } from "@nestjs/common";
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { ChatDto, MessageDto } from "@dovetalk/contracts";
import { type Database, type MessageRow, schema } from "@dovetalk/db";
import { dovetalkMetrics, withSpan } from "@dovetalk/telemetry";

import { loadChatViews, visibleOriginal } from "../conversations/chat-views.js";
import { collectPeople } from "../conversations/message-views.js";
import {
  createDirectory,
  Projector,
  type ReactionSource,
  type ViewerDirectory,
} from "../conversations/projector.js";
import { toStatusDto } from "../conversations/status-dto.js";
import { AttachmentsService } from "../storage/attachments.service.js";
import { DRIZZLE } from "../tokens.js";
import { PresenceService } from "./presence.service.js";
import { RealtimePublisher } from "./realtime.publisher.js";
import { forEachLimited, onlineFor } from "./visibility.js";

const { chatMembers, chats, contacts, messageHidden, messageReactions, messages, statuses, users } =
  schema;

/** Chats and members loaded at once while telling a group. Keeps one busy group from taking the pool. */
const CONCURRENCY = 6;

const WHITESPACE = /\s+/u;
const firstName = (name: string) => name.trim().split(WHITESPACE)[0] || name;

/**
 * Tells connected people what just happened, in each person's own terms.
 *
 * Every method is called after the transaction that made the change has committed, and reads
 * what it needs again from the database, so what goes out is what was stored. Nothing here can
 * fail a request: the methods return at once, the work runs in the background and its errors are
 * logged. Work for one chat runs in order (a message sent first is announced first), on this
 * instance. Two instances announcing the same chat at once can interleave, which the client
 * tolerates: it matches messages by id, and refetches after a reconnect.
 *
 * The cost of a message does not grow with the size of the chat: one round of queries loads the
 * message, its reactions and files, and every recipient's address book, and the projector (which
 * is pure) makes each person's copy.
 */
@Injectable()
export class RealtimeEvents implements BeforeApplicationShutdown {
  private readonly logger = new Logger("RealtimeEvents");
  private readonly lanes = new Map<string, Promise<void>>();
  private readonly running = new Set<Promise<void>>();

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(Projector) private readonly projector: Projector,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
    @Inject(RealtimePublisher) private readonly publisher: RealtimePublisher,
    @Inject(PresenceService) private readonly presence: PresenceService,
  ) {}

  // ---- what the services call ----------------------------------------------------------

  /** A message was stored. Every member who can see it gets `message:new` and their `chat:updated`. */
  messageCreated(chatId: string, messageId: string): void {
    // The clock starts now, when the send has committed, so the fan-out time includes waiting
    // for the chat's earlier announcements, which is what a recipient would feel.
    const committedAt = performance.now();
    this.enqueue(chatId, () => this.fanOutMessage(chatId, messageId, "new", committedAt));
  }

  /** A message was edited, deleted for everyone or reacted to. Every member who can see it gets `message:updated`. */
  messageUpdated(chatId: string, messageId: string): void {
    this.enqueue(chatId, () => this.fanOutMessage(chatId, messageId, "updated", performance.now()));
  }

  /** The chat as these people see it changed (pin, mute, unread, a rename, new members). Each gets `chat:updated`. */
  chatChanged(chatId: string, userIds: readonly string[]): void {
    this.enqueue(chatId, () => this.sendChats(chatId, userIds));
  }

  /** The chat left this person's list. */
  chatRemoved(userId: string, chatId: string): void {
    this.enqueue(chatId, () => {
      this.publisher.emitToUser(userId, "chat:removed", { chatId });
      return Promise.resolve();
    });
  }

  /** A status was posted. The author's other devices and everybody with the author as a contact get `status:new`. */
  statusCreated(ownerId: string, statusId: string): void {
    this.enqueue(`status:${ownerId}`, () => this.fanOutStatus(ownerId, statusId));
  }

  /**
   * Somebody started or stopped typing. Does nothing unless `typerId` is in the chat. Nobody who
   * blocked the typer, or was blocked by them, hears it.
   */
  typing(chatId: string, typerId: string, isTyping: boolean): void {
    this.enqueue(`typing:${chatId}:${typerId}`, () => this.fanOutTyping(chatId, typerId, isTyping));
  }

  /** Somebody came online or went offline. Everybody who has them as a contact hears it, unless blocked. */
  presenceChanged(userId: string, online: boolean): void {
    this.enqueue(`presence:${userId}`, () => this.fanOutPresence(userId, online));
  }

  /**
   * `ownerId` blocked or unblocked `targetId`. Each of them now sees the other as offline, or as
   * their real state again, which the contact list would say after a reload.
   */
  blockChanged(ownerId: string, targetId: string): void {
    this.enqueue(`presence:${targetId}`, () => this.fanOutBlock(ownerId, targetId));
  }

  /** Resolves when everything asked for so far has been sent. For tests and for shutdown. */
  async idle(): Promise<void> {
    while (this.running.size > 0) {
      // biome-ignore lint/performance/noAwaitInLoops: more work can be queued while these finish, so it waits again until there is none.
      await Promise.allSettled([...this.running]);
    }
    await this.publisher.flush();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.idle();
  }

  // ---- plumbing ------------------------------------------------------------------------

  /** Jobs with the same lane run one after another. Different lanes run side by side. */
  private enqueue(lane: string, job: () => Promise<void>): void {
    const previous = this.lanes.get(lane) ?? Promise.resolve();
    const next: Promise<void> = previous
      .then(job)
      .catch((error: unknown) => {
        this.logger.error(
          `Could not send a realtime event (${lane}): ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
        );
      })
      .finally(() => {
        this.running.delete(next);
        if (this.lanes.get(lane) === next) {
          this.lanes.delete(lane);
        }
      });
    this.lanes.set(lane, next);
    this.running.add(next);
  }

  // ---- messages ------------------------------------------------------------------------

  private fanOutMessage(
    chatId: string,
    messageId: string,
    kind: "new" | "updated",
    committedAt: number,
  ): Promise<void> {
    const event = kind === "new" ? "message:new" : "message:updated";
    return withSpan(
      `realtime.fanout ${event}`,
      { attributes: { "chat.id": chatId, "message.id": messageId, "socket.event": event } },
      async (span) => {
        const context = await this.loadMessageContext(chatId, messageId, kind);
        if (!context) {
          return;
        }
        const {
          chat,
          message,
          members,
          original,
          hidden,
          recipients,
          reactions,
          signed,
          replyFileName,
        } = context;
        span.setAttribute("recipients.count", recipients.length);

        const people = new Set(members.map((member) => member.userId));
        collectPeople(people, message);
        if (original) {
          collectPeople(people, original);
        }
        for (const { userId } of reactions) {
          people.add(userId);
        }
        const directories = await this.directories(
          recipients.map((member) => member.userId),
          [...people],
        );

        // Everything is handed to Redis in one go, and the span and the timer end when Redis has
        // taken it: that is the part of delivery this process is answerable for.
        await this.publisher.publishedBy(() => {
          for (const member of recipients) {
            const directory = directories.get(member.userId) ?? createDirectory(member.userId, []);
            const reply = original
              ? visibleOriginal(
                  chatId,
                  member.clearedBeforeSeq,
                  original,
                  hidden.has(`${member.userId}:${original.id}`),
                )
              : null;
            const view: MessageDto = this.projector.toMessageDto(directory, message, reply, {
              attachment: signed ?? null,
              reactions,
              replyFileName,
            });

            if (kind === "updated") {
              this.publisher.emitToUser(member.userId, "message:updated", { message: view });
              continue;
            }
            this.publisher.emitToUser(member.userId, "message:new", { message: view });
            // The new message is the last one for everybody who can see it, so the chat is made
            // from what is already loaded: the person's own unread count and flags, and the
            // other members.
            const chatView: ChatDto = this.projector.toChatDto(directory, {
              chat,
              member,
              otherUserIds: members.filter((m) => m.userId !== member.userId).map((m) => m.userId),
              lastMessage: view,
            });
            this.publisher.emitToUser(member.userId, "chat:updated", { chat: chatView });
          }
        });
        dovetalkMetrics().messageFanoutDuration.record(performance.now() - committedAt, { event });
      },
    );
  }

  /**
   * Everything about one message that is the same for every viewer: the rows, who can see it, its
   * reactions and its file (signed once). The per-viewer part is only a projection of this.
   */
  private async loadMessageContext(chatId: string, messageId: string, kind: "new" | "updated") {
    const { db } = this;
    const [found] = await db
      .select({ message: messages, chat: chats })
      .from(messages)
      .innerJoin(chats, eq(chats.id, messages.chatId))
      .where(and(eq(messages.id, messageId), eq(messages.chatId, chatId)))
      .limit(1);
    if (!found) {
      return null;
    }
    const { message, chat } = found;

    const members = await db
      .select()
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), isNull(chatMembers.leftAt)))
      .orderBy(asc(chatMembers.joinedAt), asc(chatMembers.userId));

    let original: MessageRow | null = null;
    if (message.replyToId) {
      [original = null] = await db
        .select()
        .from(messages)
        .where(eq(messages.id, message.replyToId))
        .limit(1);
    }

    const hiddenRows = await db
      .select({ userId: messageHidden.userId, messageId: messageHidden.messageId })
      .from(messageHidden)
      .where(inArray(messageHidden.messageId, original ? [message.id, original.id] : [message.id]));
    const hidden = new Set(hiddenRows.map((row) => `${row.userId}:${row.messageId}`));

    // Who can see it: on their list, after the point their history starts, and not hidden from them
    // (a message to somebody who blocked the sender is hidden from them for good).
    const recipients = members.filter(
      (member) =>
        !member.hiddenAt &&
        message.seq > member.clearedBeforeSeq &&
        !hidden.has(`${member.userId}:${message.id}`),
    );
    if (recipients.length === 0) {
      return null;
    }

    // A message that was just stored has no reactions yet. Somebody who reacts in the moment
    // between the commit and this read gets their own `message:updated`, queued behind this one
    // on the chat's lane, so skipping the query loses nothing and saves a round trip per send.
    const reactions: ReactionSource[] =
      message.deleted || kind === "new"
        ? []
        : await db
            .select({ emoji: messageReactions.emoji, userId: messageReactions.userId })
            .from(messageReactions)
            .where(eq(messageReactions.messageId, message.id))
            .orderBy(asc(messageReactions.createdAt), asc(messageReactions.userId));

    const fileIds = new Set<string>();
    if (message.attachmentId) {
      fileIds.add(message.attachmentId);
    }
    if (original?.attachmentId && !original.deleted) {
      fileIds.add(original.attachmentId);
    }
    const files = await this.attachments.rows(db, fileIds);
    const own = message.attachmentId ? files.get(message.attachmentId) : undefined;
    const signed = own ? (await this.attachments.sign([own])).get(own.id) : undefined;
    const replyFileName = original?.attachmentId
      ? (files.get(original.attachmentId)?.name ?? null)
      : null;

    return {
      chat,
      message,
      members,
      original,
      hidden,
      recipients,
      reactions,
      signed,
      replyFileName,
    };
  }

  /** Each viewer's address book, limited to the people that matter. One query for all of them. */
  private async directories(
    viewerIds: readonly string[],
    peopleIds: readonly string[],
  ): Promise<Map<string, ViewerDirectory>> {
    const rows = await this.db
      .select({
        ownerId: contacts.ownerId,
        userId: contacts.linkedUserId,
        contactId: contacts.id,
        name: contacts.name,
        contactHue: contacts.hue,
        profileHue: users.hue,
      })
      .from(contacts)
      .innerJoin(users, eq(users.id, contacts.linkedUserId))
      .where(
        and(
          inArray(contacts.ownerId, [...viewerIds]),
          inArray(contacts.linkedUserId, [...peopleIds]),
        ),
      );
    const byOwner = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byOwner.get(row.ownerId);
      if (list) {
        list.push(row);
      } else {
        byOwner.set(row.ownerId, [row]);
      }
    }
    return new Map(
      [...byOwner].map(([ownerId, list]) => [
        ownerId,
        createDirectory(
          ownerId,
          list.map((row) => ({
            userId: row.userId,
            contactId: row.contactId,
            name: row.name,
            hue: row.contactHue ?? row.profileHue,
          })),
        ),
      ]),
    );
  }

  // ---- chats ---------------------------------------------------------------------------

  private async sendChats(chatId: string, userIds: readonly string[]) {
    await forEachLimited([...new Set(userIds)], CONCURRENCY, async (userId) => {
      const [view] = await loadChatViews(
        this.db,
        { projector: this.projector, attachments: this.attachments },
        userId,
        chatId,
      );
      // Not on their list (deleted it, or left): nothing to update.
      if (view) {
        this.publisher.emitToUser(userId, "chat:updated", { chat: view });
      }
    });
  }

  // ---- statuses ------------------------------------------------------------------------

  private async fanOutStatus(ownerId: string, statusId: string) {
    const [status] = await this.db
      .select()
      .from(statuses)
      .where(eq(statuses.id, statusId))
      .limit(1);
    if (!status || status.expiresAt.getTime() <= Date.now()) {
      return;
    }
    // Anybody with a contact row for the author sees their statuses, saved or not (edge case 38).
    const watchers = await this.db
      .select({ ownerId: contacts.ownerId, contactId: contacts.id })
      .from(contacts)
      .where(eq(contacts.linkedUserId, ownerId));

    // The author's own devices see it as theirs and as seen.
    this.publisher.emitToUser(ownerId, "status:new", {
      status: toStatusDto(ownerId, status, null, true),
    });
    for (const { ownerId: viewerId, contactId } of watchers) {
      // A note made for one account (the seeded bots') goes to that account only.
      if (status.audienceId && status.audienceId !== viewerId) {
        continue;
      }
      this.publisher.emitToUser(viewerId, "status:new", {
        status: toStatusDto(viewerId, status, contactId, false),
      });
    }
  }

  // ---- typing and presence -------------------------------------------------------------

  private async fanOutTyping(chatId: string, typerId: string, isTyping: boolean) {
    const me = alias(chatMembers, "me");
    const other = alias(chatMembers, "other");
    const back = alias(contacts, "back");
    const rows = await this.db
      .select({
        recipientId: other.userId,
        contactId: contacts.id,
        name: contacts.name,
        theyBlockedTyper: contacts.blocked,
        typerBlockedThem: back.blocked,
      })
      .from(me)
      .innerJoin(
        other,
        and(
          eq(other.chatId, me.chatId),
          ne(other.userId, me.userId),
          isNull(other.leftAt),
          isNull(other.hiddenAt),
        ),
      )
      // Their name for the typer, in their own address book. Bots own no contacts, so they hear nothing.
      .innerJoin(
        contacts,
        and(eq(contacts.ownerId, other.userId), eq(contacts.linkedUserId, me.userId)),
      )
      .leftJoin(back, and(eq(back.ownerId, me.userId), eq(back.linkedUserId, other.userId)))
      .where(and(eq(me.chatId, chatId), eq(me.userId, typerId), isNull(me.leftAt)));

    for (const row of rows) {
      if (row.theyBlockedTyper || row.typerBlockedThem) {
        continue;
      }
      this.publisher.emitToUser(row.recipientId, "typing", {
        chatId,
        contactId: row.contactId,
        name: firstName(row.name),
        isTyping,
      });
    }
  }

  private async fanOutPresence(userId: string, online: boolean) {
    const back = alias(contacts, "back");
    const rows = await this.db
      .select({
        viewerId: contacts.ownerId,
        contactId: contacts.id,
        theyBlocked: contacts.blocked,
        iBlocked: back.blocked,
      })
      .from(contacts)
      .leftJoin(back, and(eq(back.ownerId, userId), eq(back.linkedUserId, contacts.ownerId)))
      .where(eq(contacts.linkedUserId, userId));
    for (const row of rows) {
      this.publisher.emitToUser(row.viewerId, "presence", {
        contactId: row.contactId,
        online: online && !row.theyBlocked && !row.iBlocked,
      });
    }
  }

  private async fanOutBlock(ownerId: string, targetId: string) {
    const rows = await this.db
      .select({
        ownerId: contacts.ownerId,
        targetId: contacts.linkedUserId,
        contactId: contacts.id,
        blocked: contacts.blocked,
        isBot: users.isBot,
        botOnlineDefault: users.botOnlineDefault,
      })
      .from(contacts)
      .innerJoin(users, eq(users.id, contacts.linkedUserId))
      .where(
        and(
          inArray(contacts.ownerId, [ownerId, targetId]),
          inArray(contacts.linkedUserId, [ownerId, targetId]),
        ),
      );
    const blockedEitherWay = rows.some((row) => row.blocked);
    const online = await this.presence.onlineAmong([ownerId, targetId]);
    for (const row of rows) {
      this.publisher.emitToUser(row.ownerId, "presence", {
        contactId: row.contactId,
        online: onlineFor({
          isBot: row.isBot,
          botOnlineDefault: row.botOnlineDefault,
          live: online.has(row.targetId),
          blockedEitherWay,
        }),
      });
    }
  }
}
