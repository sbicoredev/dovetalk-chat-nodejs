import { randomInt } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { and, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";

import {
  type ChatDto,
  type CreateChatInput,
  GROUP_MEMBERS_MAX,
  GROUP_NAME_MAX,
  PIN_LIMIT,
  type UpdateChatInput,
} from "@dovetalk/contracts";
import { type Database, type MessageRow, newId, schema, type Transaction } from "@dovetalk/db";

import { DomainError } from "../errors.js";
import { must } from "../invariant.js";
import { RealtimeEvents } from "../realtime/realtime-events.service.js";
import { AttachmentsService } from "../storage/attachments.service.js";
import { DRIZZLE } from "../tokens.js";
import { loadChatViews } from "./chat-views.js";
import { ContactsService } from "./contacts.service.js";
import { advisoryLock, directKey, isUuid } from "./ids.js";
import { findVisibleChat, hideChat, RESET_FLAGS } from "./membership.js";
import { MessageStore } from "./message-store.js";
import { Projector } from "./projector.js";

const { chats, chatMembers, contacts } = schema;

const contactNotFound = () =>
  new DomainError("CONTACT_NOT_FOUND", "This contact no longer exists.");

function requireGroupName(raw: string): string {
  const name = raw.trim();
  if (!name) {
    throw new DomainError("VALIDATION_ERROR", ["Group name can't be empty."]);
  }
  if (name.length > GROUP_NAME_MAX) {
    throw new DomainError("VALIDATION_ERROR", [
      `Group name is too long. The limit is ${GROUP_NAME_MAX} characters.`,
    ]);
  }
  return name;
}

/** Valid, distinct ids, in the order they were given. Anything else is dropped like an unknown id. */
const distinctUuids = (ids: readonly unknown[]): string[] => [...new Set(ids.filter(isUuid))];

/**
 * Chats, as one viewer sees them. A chat is one shared row; what is the viewer's own (unread,
 * pinned, archived, muted, hidden, where their history starts) lives on their membership row.
 *
 * Rules that come up in several places:
 * - A chat the viewer cannot see is `CHAT_NOT_FOUND` (404), whether it is somebody else's, one they
 *   left, one they deleted or none at all. Never 403.
 * - Group changes lock the chat's row, so two of them cannot interleave.
 * - What changed is announced after the transaction commits (`RealtimeEvents`): a change to the
 *   viewer's own flags goes to the viewer's devices alone, a change everybody sees (a rename, new
 *   members, a system note) goes to every member, each in their own terms.
 */
@Injectable()
export class ChatsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(Projector) private readonly projector: Projector,
    @Inject(ContactsService) private readonly contactBook: ContactsService,
    @Inject(MessageStore) private readonly store: MessageStore,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
    @Inject(RealtimeEvents) private readonly events: RealtimeEvents,
  ) {}

  private get views() {
    return { projector: this.projector, attachments: this.attachments };
  }

  /** The viewer's chat list: five queries however long it is. */
  list(viewerId: string): Promise<ChatDto[]> {
    return loadChatViews(this.db, this.views, viewerId);
  }

  /**
   * Opens a direct chat with a contact, or a group. `created` is true when a new chat row was
   * made, so the API can answer 201 or 200. A direct chat the viewer deleted comes back, empty.
   */
  async create(
    viewerId: string,
    input: CreateChatInput,
  ): Promise<{ chat: ChatDto; created: boolean }> {
    return input.type === "direct"
      ? this.createDirect(viewerId, input.contactId)
      : { chat: await this.createGroup(viewerId, input.name, input.memberIds), created: true };
  }

  async update(viewerId: string, chatId: string, patch: UpdateChatInput): Promise<ChatDto> {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one transaction that checks each field of a patch in order, under one lock; splitting it would scatter that sequence.
    const { view, note } = await this.db.transaction(async (tx) => {
      // The pin limit is "count, then pin", which two requests at once would both pass.
      if (patch.pinned === true) {
        await advisoryLock(tx, `pins:${viewerId}`);
      }
      const { chat, member } = await findVisibleChat(tx, viewerId, chatId, {
        lock: patch.name !== undefined,
      });

      if (patch.pinned === true && !member.pinned) {
        const [{ pinned }] = await tx
          .select({ pinned: count() })
          .from(chatMembers)
          .where(
            and(
              eq(chatMembers.userId, viewerId),
              eq(chatMembers.pinned, true),
              isNull(chatMembers.leftAt),
              isNull(chatMembers.hiddenAt),
            ),
          );
        if (pinned >= PIN_LIMIT) {
          throw new DomainError(
            "PIN_LIMIT",
            `You can pin up to ${PIN_LIMIT} chats. Unpin one first.`,
          );
        }
      }

      let rename: string | undefined;
      if (patch.name !== undefined) {
        if (chat.type !== "group") {
          throw new DomainError("VALIDATION_ERROR", ["Only groups can be renamed."]);
        }
        const name = requireGroupName(patch.name);
        // Saying the same name again is not a rename: no change, and no note in the chat.
        if (name !== chat.name) {
          rename = name;
        }
      }

      const flags: Partial<typeof chatMembers.$inferInsert> = {};
      if (patch.archived !== undefined) {
        flags.archived = patch.archived;
      }
      if (patch.pinned !== undefined) {
        flags.pinned = patch.pinned;
      }
      if (patch.muted !== undefined) {
        flags.muted = patch.muted;
      }
      if (Object.keys(flags).length > 0) {
        await tx
          .update(chatMembers)
          .set(flags)
          .where(and(eq(chatMembers.chatId, chat.id), eq(chatMembers.userId, viewerId)));
      }

      let renamed: MessageRow | null = null;
      if (rename !== undefined) {
        await tx.update(chats).set({ name: rename }).where(eq(chats.id, chat.id));
        renamed = await this.store.append(tx, {
          chatId: chat.id,
          senderId: null,
          kind: "system",
          event: { type: "group_renamed", actorId: viewerId, name: rename },
        });
      }
      return { view: await this.viewOf(tx, viewerId, chat.id), note: renamed };
    });
    if (note) {
      // Everybody sees the new name and the note. That includes the viewer's own flags, which
      // the same event carries, so a second `chat:updated` just for them is not needed.
      this.events.messageCreated(chatId, note.id);
    } else {
      this.events.chatChanged(chatId, [viewerId]);
    }
    return view;
  }

  /** Deletes the chat from the viewer's list and ends their history there. Nobody else is affected. */
  async remove(viewerId: string, chatId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { chat } = await findVisibleChat(tx, viewerId, chatId);
      await hideChat(tx, viewerId, chat.id);
    });
    this.events.chatRemoved(viewerId, chatId);
  }

  async markRead(viewerId: string, chatId: string): Promise<void> {
    const { chat, member } = await findVisibleChat(this.db, viewerId, chatId);
    await this.db
      .update(chatMembers)
      .set({ unreadCount: 0 })
      .where(and(eq(chatMembers.chatId, chat.id), eq(chatMembers.userId, viewerId)));
    // The viewer's other devices drop their badge. Reading an already read chat tells nobody.
    if (member.unreadCount > 0) {
      this.events.chatChanged(chat.id, [viewerId]);
    }
  }

  /** Empties the chat for the viewer only. It stays on their list, pinned and archived as it was. */
  async clear(viewerId: string, chatId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const { chat } = await findVisibleChat(tx, viewerId, chatId);
      await tx
        .update(chatMembers)
        .set({
          clearedBeforeSeq: sql`(select last_seq from chats where id = ${chat.id})`,
          unreadCount: 0,
        })
        .where(and(eq(chatMembers.chatId, chat.id), eq(chatMembers.userId, viewerId)));
    });
    this.events.chatChanged(chatId, [viewerId]);
  }

  /**
   * Any member may add people. They see the chat from the moment they are added, with the
   * "added" note as the first thing in it.
   */
  async addMembers(viewerId: string, chatId: string, memberIds: string[]): Promise<ChatDto> {
    const { view, note } = await this.db.transaction(async (tx) => {
      const { chat } = await findVisibleChat(tx, viewerId, chatId, { lock: true });
      this.requireGroup(chat.type, "Only groups have members.");

      const wanted = await this.ownContacts(tx, viewerId, distinctUuids(memberIds));
      const current = await tx
        .select({ userId: chatMembers.userId, leftAt: chatMembers.leftAt })
        .from(chatMembers)
        .where(eq(chatMembers.chatId, chat.id));
      const active = new Set(current.filter((m) => !m.leftAt).map((m) => m.userId));
      const known = new Set(current.map((m) => m.userId));
      const fresh = wanted.filter((userId) => !active.has(userId));
      if (fresh.length === 0) {
        return { view: await this.viewOf(tx, viewerId, chat.id), note: null };
      }

      // Everyone in the group but the viewer. The limit counts the others, not the owner.
      if (active.size - 1 + fresh.length > GROUP_MEMBERS_MAX) {
        throw new DomainError("VALIDATION_ERROR", [
          `A group can have at most ${GROUP_MEMBERS_MAX} other people.`,
        ]);
      }

      const rejoining = fresh.filter((userId) => known.has(userId));
      const joining = fresh.filter((userId) => !known.has(userId));
      const startsHere = sql`(select last_seq from chats where id = ${chat.id})`;
      if (rejoining.length > 0) {
        await tx
          .update(chatMembers)
          .set({
            leftAt: null,
            hiddenAt: null,
            joinedAt: sql`now()`,
            clearedBeforeSeq: startsHere,
            ...RESET_FLAGS,
          })
          .where(and(eq(chatMembers.chatId, chat.id), inArray(chatMembers.userId, rejoining)));
      }
      if (joining.length > 0) {
        await tx
          .insert(chatMembers)
          .values(
            joining.map((userId) => ({ chatId: chat.id, userId, clearedBeforeSeq: startsHere })),
          );
      }
      await this.contactBook.ensureContacts(tx, chat.id);
      const added = await this.store.append(tx, {
        chatId: chat.id,
        senderId: null,
        kind: "system",
        event: { type: "members_added", actorId: viewerId, targetIds: fresh },
      });
      return { view: await this.viewOf(tx, viewerId, chat.id), note: added };
    });
    // The note reaches everybody now in the group, the new people included, and brings the chat
    // onto their lists with it.
    if (note) {
      this.events.messageCreated(chatId, note.id);
    }
    return view;
  }

  /**
   * Only the person who made the group may remove people, and it must keep at least two other
   * members. A removed person loses the chat at once (it is 404 for them) and their history ends.
   * Checks run in this order, so a failing request always gets the same answer.
   */
  async removeMember(viewerId: string, chatId: string, contactId: string): Promise<ChatDto> {
    const { view, note, removed } = await this.db.transaction(async (tx) => {
      const { chat } = await findVisibleChat(tx, viewerId, chatId, { lock: true });
      this.requireGroup(chat.type, "Only groups have members.");
      if (chat.createdBy !== viewerId) {
        throw new DomainError(
          "FORBIDDEN",
          "Only the person who created this group can remove people.",
        );
      }

      const notMember = () =>
        new DomainError("MEMBER_NOT_FOUND", "That person isn't in this group.");
      const [target] = isUuid(contactId) ? await this.ownContacts(tx, viewerId, [contactId]) : [];
      if (!target) {
        throw notMember();
      }

      const others = await tx
        .select({ userId: chatMembers.userId })
        .from(chatMembers)
        .where(
          and(
            eq(chatMembers.chatId, chat.id),
            ne(chatMembers.userId, viewerId),
            isNull(chatMembers.leftAt),
          ),
        );
      if (!others.some((m) => m.userId === target)) {
        throw notMember();
      }
      if (others.length - 1 < 2) {
        throw new DomainError("VALIDATION_ERROR", ["A group keeps at least two other members."]);
      }

      await tx
        .update(chatMembers)
        .set({ leftAt: sql`now()`, ...RESET_FLAGS })
        .where(and(eq(chatMembers.chatId, chat.id), eq(chatMembers.userId, target)));
      const goodbye = await this.store.append(tx, {
        chatId: chat.id,
        senderId: null,
        kind: "system",
        event: { type: "members_removed", actorId: viewerId, targetIds: [target] },
      });
      return { view: await this.viewOf(tx, viewerId, chat.id), note: goodbye, removed: target };
    });
    // The person removed loses the chat at once. Everybody who is left sees the note.
    this.events.chatRemoved(removed, chatId);
    this.events.messageCreated(chatId, note.id);
    return view;
  }

  private async createDirect(
    viewerId: string,
    contactId: string,
  ): Promise<{ chat: ChatDto; created: boolean }> {
    if (!isUuid(contactId)) {
      throw contactNotFound();
    }
    const result = await this.db.transaction(async (tx) => {
      const [contact] = await tx
        .select({ userId: contacts.linkedUserId })
        .from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.ownerId, viewerId)))
        .limit(1);
      if (!contact) {
        throw contactNotFound();
      }

      const key = directKey(viewerId, contact.userId);
      // A unique key makes the pair one chat even when both open it in the same instant. The
      // loser waits for the winner's commit and then falls through to the lookup below.
      const [made] = await tx
        .insert(chats)
        .values({ type: "direct", directKey: key, createdBy: viewerId })
        .onConflictDoNothing({ target: chats.directKey })
        .returning({ id: chats.id });

      if (made) {
        await tx.insert(chatMembers).values([
          { chatId: made.id, userId: viewerId },
          // The other person does not see the chat until a message reaches them.
          { chatId: made.id, userId: contact.userId, hiddenAt: sql`now()` },
        ]);
        await this.contactBook.ensureContacts(tx, made.id);
        return { chat: await this.viewOf(tx, viewerId, made.id), created: true, changed: true };
      }

      const [found] = await tx.select().from(chats).where(eq(chats.directKey, key)).limit(1);
      const chat = must(found, "the direct chat that won the insert race");
      const [member] = await tx
        .select()
        .from(chatMembers)
        .where(and(eq(chatMembers.chatId, chat.id), eq(chatMembers.userId, viewerId)))
        .limit(1);
      let changed = false;
      if (!member) {
        await tx
          .insert(chatMembers)
          .values({ chatId: chat.id, userId: viewerId, clearedBeforeSeq: chat.lastSeq });
        changed = true;
      } else if (member.hiddenAt) {
        // Opening a chat the viewer deleted brings it back empty: what they cleared stays gone.
        await tx
          .update(chatMembers)
          .set({ hiddenAt: null, clearedBeforeSeq: chat.lastSeq })
          .where(and(eq(chatMembers.chatId, chat.id), eq(chatMembers.userId, viewerId)));
        changed = true;
      }
      return { chat: await this.viewOf(tx, viewerId, chat.id), created: false, changed };
    });
    // Opening a chat that is already on the list changes nothing. A new or revived one reaches
    // the viewer's other devices. The other person hears about it with the first message.
    if (result.changed) {
      this.events.chatChanged(result.chat.id, [viewerId]);
    }
    return { chat: result.chat, created: result.created };
  }

  private async createGroup(
    viewerId: string,
    rawName: string,
    memberIds: string[],
  ): Promise<ChatDto> {
    const name = requireGroupName(rawName);
    const { view, note } = await this.db.transaction(async (tx) => {
      const people = await this.ownContacts(tx, viewerId, distinctUuids(memberIds));
      if (people.length < 2) {
        throw new DomainError("VALIDATION_ERROR", ["A group needs at least two other people."]);
      }
      if (people.length > GROUP_MEMBERS_MAX) {
        throw new DomainError("VALIDATION_ERROR", [
          `A group can have at most ${GROUP_MEMBERS_MAX} other people.`,
        ]);
      }

      const chatId = newId();
      await tx.insert(chats).values({
        id: chatId,
        type: "group",
        name,
        hue: randomInt(360),
        createdBy: viewerId,
      });
      // `joined_at` follows the order given, which is the order the members are listed in.
      const base = Date.now();
      await tx.insert(chatMembers).values(
        [viewerId, ...people].map((userId, index) => ({
          chatId,
          userId,
          joinedAt: new Date(base + index),
        })),
      );
      await this.contactBook.ensureContacts(tx, chatId);
      const created = await this.store.append(tx, {
        chatId,
        senderId: null,
        kind: "system",
        event: { type: "group_created", actorId: viewerId },
      });
      return { view: await this.viewOf(tx, viewerId, chatId), note: created };
    });
    // "You created this group" reaches every member and puts the group on their lists.
    this.events.messageCreated(view.id, note.id);
    return view;
  }

  /**
   * The user ids behind some of the viewer's own contacts, in the order the contact ids were
   * given. Ids that are not the viewer's contacts are dropped.
   */
  private async ownContacts(
    tx: Transaction,
    viewerId: string,
    contactIds: string[],
  ): Promise<string[]> {
    if (contactIds.length === 0) {
      return [];
    }
    const rows = await tx
      .select({ id: contacts.id, userId: contacts.linkedUserId })
      .from(contacts)
      .where(and(eq(contacts.ownerId, viewerId), inArray(contacts.id, contactIds)));
    const byId = new Map(rows.map((row) => [row.id, row.userId]));
    return contactIds.flatMap((id) => byId.get(id) ?? []);
  }

  private requireGroup(type: string, message: string) {
    if (type !== "group") {
      throw new DomainError("VALIDATION_ERROR", [message]);
    }
  }

  private async viewOf(tx: Transaction, viewerId: string, chatId: string): Promise<ChatDto> {
    const [view] = await loadChatViews(tx, this.views, viewerId, chatId);
    if (!view) {
      throw new DomainError("CHAT_NOT_FOUND", "This chat no longer exists.");
    }
    return view;
  }
}
