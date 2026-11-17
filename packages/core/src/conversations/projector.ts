import { Injectable } from "@nestjs/common";

import {
  type AttachmentDto,
  type ChatDto,
  type ContactDto,
  type MessageDto,
  type ReplyPreview,
  SYSTEM_SENDER,
} from "@dovetalk/contracts";
import type {
  ChatMemberRow,
  ChatRow,
  ContactRow,
  MessageRow,
  SystemEvent,
  UserRow,
} from "@dovetalk/db";

/**
 * How one viewer names the other people. Every id the API sends is in the viewer's own terms
 * (docs/adr/0003): the viewer is `MeDto.id`, everybody else is the viewer's contact for them,
 * and notices come from `"system"`. This is the lookup that gets a user id into those terms.
 */
export interface ViewerDirectory {
  /** User id to the viewer's contact id. */
  contactIds: ReadonlyMap<string, string>;
  /** User id to the colour the viewer sees them in: the contact's own, else their profile's. */
  hues: ReadonlyMap<string, number>;
  /** User id to the name the viewer has for them. */
  names: ReadonlyMap<string, string>;
  viewerId: string;
}

export interface DirectoryEntry {
  contactId: string;
  hue: number;
  name: string;
  userId: string;
}

export function createDirectory(
  viewerId: string,
  entries: Iterable<DirectoryEntry>,
): ViewerDirectory {
  const contactIds = new Map<string, string>();
  const names = new Map<string, string>();
  const hues = new Map<string, number>();
  for (const entry of entries) {
    contactIds.set(entry.userId, entry.contactId);
    names.set(entry.userId, entry.name);
    hues.set(entry.userId, entry.hue);
  }
  return { viewerId, contactIds, names, hues };
}

/** The columns of a contact row that show up in a `ContactDto`. */
export type ContactSource = Pick<
  ContactRow,
  "id" | "name" | "phone" | "about" | "hue" | "avatarUrl" | "blocked" | "saved"
>;
/**
 * The linked person's side of a contact: what shows through where the owner set nothing.
 * `avatarUrl` is the profile photo already signed, or `null`: the row only holds the attachment.
 */
export type ProfileSource = Pick<UserRow, "about" | "hue" | "isBot" | "botOnlineDefault"> & {
  avatarUrl: string | null;
  /**
   * Whether a real person is online as this viewer may see it (connected, and not blocked either
   * way): worked out by the caller, because it comes from Redis. Ignored for bots.
   */
  online?: boolean;
};

/** One person's reaction to one message, as stored. The people are user ids. */
export interface ReactionSource {
  emoji: string;
  userId: string;
}

/** What a message needs besides its own row: the things that live in other tables. */
export interface MessageExtras {
  attachment?: AttachmentDto | null;
  /** In the order they were made: that is the order the emoji and the people appear in. */
  reactions?: readonly ReactionSource[];
  /** The file name of the message being replied to, shown when it has no text. */
  replyFileName?: string | null;
}

export interface ChatViewInput {
  chat: ChatRow;
  lastMessage: MessageDto | null;
  /** The viewer's own membership. */
  member: Pick<ChatMemberRow, "unreadCount" | "archived" | "pinned" | "muted">;
  /** User ids of the other active members, in the order they joined. */
  otherUserIds: readonly string[];
}

const SOMEONE = "someone";

/** "Imogen Varley" to "Imogen". */
const WHITESPACE = /\s+/u;
const firstName = (name: string) => name.trim().split(WHITESPACE)[0] ?? name;

/** `["A"]` to "A", `["A", "B"]` to "A and B", `["A", "B", "C"]` to "A, B and C". */
function list(names: string[]): string {
  if (names.length <= 1) {
    return names[0] ?? SOMEONE;
  }
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/**
 * Turns database rows into the DTOs one viewer sees. It is pure: everything it needs is passed
 * in, so the same input always gives the same output and nothing here touches the database.
 * Loading the rows, and the viewer's directory, is the services' job.
 */
@Injectable()
export class Projector {
  /** A user in the viewer's terms. A person the viewer has no contact for reads as `"system"`. */
  senderId(directory: ViewerDirectory, userId: string | null): string {
    if (userId === null) {
      return SYSTEM_SENDER;
    }
    if (userId === directory.viewerId) {
      return userId;
    }
    return directory.contactIds.get(userId) ?? SYSTEM_SENDER;
  }

  toContactDto(contact: ContactSource, profile: ProfileSource): ContactDto {
    return {
      id: contact.id,
      name: contact.name,
      phone: contact.phone ?? "",
      about: contact.about ?? profile.about,
      hue: contact.hue ?? profile.hue,
      // Bots are as available as they were seeded. Real people are online while connected.
      online: profile.isBot ? profile.botOnlineDefault : (profile.online ?? false),
      blocked: contact.blocked,
      avatarUrl: contact.avatarUrl ?? profile.avatarUrl,
      saved: contact.saved,
    };
  }

  /**
   * What a system message says to this viewer. The same event reads "You added Priya" to the one
   * who added her, "Alex added you" to her and "Alex added Priya" to everyone else.
   */
  systemText(directory: ViewerDirectory, event: SystemEvent | null): string {
    if (!event) {
      return "";
    }
    const me = directory.viewerId;
    const name = (userId: string) => {
      const known = directory.names.get(userId);
      return known ? firstName(known) : SOMEONE;
    };
    const actor = event.actorId === me ? "You" : capitalise(name(event.actorId));
    /** The viewer first ("you"), then the others, as in "Alex added you and Priya". */
    const targets = (ids: string[]) =>
      list([
        ...ids.filter((id) => id === me).map(() => "you"),
        ...ids.filter((id) => id !== me).map(name),
      ]);

    switch (event.type) {
      case "group_created":
        return `${actor} created this group`;
      case "group_renamed":
        return `${actor} renamed the group to “${event.name}”`;
      case "members_added":
        return `${actor} added ${targets(event.targetIds)}`;
      case "members_removed":
        return `${actor} removed ${targets(event.targetIds)}`;
      default: {
        const unknown: never = event;
        throw new Error(`Unknown system event: ${JSON.stringify(unknown)}`);
      }
    }
  }

  /**
   * `original` is the message being replied to, or `null` when the viewer cannot see it (it is
   * gone, or older than the point where their history starts). The preview then reads as a
   * deleted message, which is what the mock does.
   */
  toReplyPreview(
    directory: ViewerDirectory,
    replyToId: string,
    original: MessageRow | null,
    fileName: string | null = null,
  ): ReplyPreview {
    if (!original) {
      return { id: replyToId, senderId: SYSTEM_SENDER, kind: "text", text: null, deleted: true };
    }
    return {
      id: original.id,
      senderId: this.senderId(directory, original.senderId),
      kind: original.kind,
      // A picture or file without a caption shows its name, as the prototype does.
      text: original.deleted ? null : (this.textOf(directory, original) ?? fileName),
      deleted: original.deleted,
    };
  }

  /**
   * Emoji to the people who used it, in the viewer's terms: the viewer is `MeDto.id`, everybody
   * else the viewer's contact. Somebody the viewer has no contact for is left out rather than
   * shown as "system": every member of a chat has a contact row, so this only drops a stranger.
   */
  toReactions(
    directory: ViewerDirectory,
    reactions: readonly ReactionSource[],
  ): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const { emoji, userId } of reactions) {
      const who = userId === directory.viewerId ? userId : directory.contactIds.get(userId);
      if (who === undefined) {
        continue;
      }
      const already = out[emoji];
      if (already) {
        already.push(who);
      } else {
        out[emoji] = [who];
      }
    }
    return out;
  }

  /**
   * `reply` is read only when `row` is a reply: pass the original, or `null` if the viewer
   * cannot see it. `extras` carries what lives in other tables (the file, the reactions).
   */
  toMessageDto(
    directory: ViewerDirectory,
    row: MessageRow,
    reply: MessageRow | null = null,
    extras: MessageExtras = {},
  ): MessageDto {
    return {
      id: row.id,
      chatId: row.chatId,
      // Only the sender's own app needs its client id back, to swap in the saved message.
      clientId: row.senderId === directory.viewerId ? row.clientId : null,
      senderId: this.senderId(directory, row.senderId),
      kind: row.kind,
      text: row.deleted ? null : this.textOf(directory, row),
      duration: row.duration,
      bars: row.bars,
      attachment: row.deleted ? null : (extras.attachment ?? null),
      createdAt: row.createdAt.getTime(),
      replyTo: row.replyToId
        ? this.toReplyPreview(directory, row.replyToId, reply, extras.replyFileName ?? null)
        : null,
      reactions: row.deleted ? {} : this.toReactions(directory, extras.reactions ?? []),
      edited: row.edited,
      deleted: row.deleted,
      forwarded: row.forwarded,
    };
  }

  toChatDto(directory: ViewerDirectory, input: ChatViewInput): ChatDto {
    const { chat, member, otherUserIds, lastMessage } = input;
    const isGroup = chat.type === "group";
    return {
      id: chat.id,
      type: chat.type,
      name: isGroup ? chat.name : null,
      // A direct chat has no colour of its own: it wears the other person's.
      hue: isGroup ? (chat.hue ?? 0) : (hueOfOther(directory, otherUserIds) ?? chat.hue ?? 0),
      memberIds: otherUserIds.flatMap((userId) => directory.contactIds.get(userId) ?? []),
      unread: member.unreadCount,
      archived: member.archived,
      pinned: member.pinned,
      muted: member.muted,
      createdAt: chat.createdAt.getTime(),
      lastMessage,
    };
  }

  private textOf(directory: ViewerDirectory, row: MessageRow): string | null {
    return row.kind === "system" ? this.systemText(directory, row.event) : row.text;
  }
}

const hueOfOther = (directory: ViewerDirectory, otherUserIds: readonly string[]) => {
  const [first] = otherUserIds;
  return first === undefined ? undefined : directory.hues.get(first);
};

const capitalise = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
