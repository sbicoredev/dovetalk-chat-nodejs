import type { ChatDto, ContactDto, MessageKind } from "@/lib/api/types";
import { SYSTEM_SENDER } from "@/lib/api/types";
import { firstName } from "@/lib/utils";

export type ContactMap = Map<string, ContactDto>;

export function lastActivity(chat: ChatDto) {
  return chat.lastMessage?.createdAt ?? chat.createdAt;
}

/** Pinned chats first, then the most recent activity. */
export function compareChats(a: ChatDto, b: ChatDto) {
  return Number(b.pinned) - Number(a.pinned) || lastActivity(b) - lastActivity(a);
}

export function chatMeta(chat: ChatDto, contacts: ContactMap) {
  if (chat.type === "group") {
    return {
      title: chat.name ?? "Group",
      hue: chat.hue,
      group: true,
      online: false,
      avatarUrl: undefined as string | undefined,
    };
  }
  const contact = contacts.get(chat.memberIds[0]);
  return {
    title: contact?.name ?? "Unknown contact",
    hue: contact?.hue ?? chat.hue,
    group: false,
    online: contact?.online ?? false,
    avatarUrl: contact?.avatarUrl ?? undefined,
  };
}

/**
 * Whether a contact belongs in the address book. The real API also lists people the person only
 * shares a chat with, or deleted from their contacts (`saved: false`): they stay in the list so
 * their messages can show a name, but they are not offered as contacts. The mock only has saved ones.
 */
export function isSavedContact(contact: ContactDto) {
  return contact.saved !== false;
}

export function isChatBlocked(chat: ChatDto, contacts: ContactMap) {
  return chat.type === "direct" && !!contacts.get(chat.memberIds[0])?.blocked;
}

interface Describable {
  attachmentName?: string | null;
  deleted: boolean;
  kind: MessageKind;
  text: string | null;
}

/** A one-line description of a message, used in previews and reply quotes. */
export function describeMessage(m: Describable) {
  if (m.deleted) {
    return "This message was deleted";
  }
  if (m.kind === "voice") {
    return "Voice message";
  }
  if (m.kind === "image") {
    return m.text ? `Photo: ${m.text}` : "Photo";
  }
  if (m.kind === "file") {
    return `File: ${m.attachmentName ?? m.text ?? "attachment"}`;
  }
  return m.text ?? "";
}

export function previewOf(chat: ChatDto, contacts: ContactMap, meId: string) {
  const last = chat.lastMessage;
  if (!last) {
    return "No messages yet";
  }
  const body = describeMessage({
    kind: last.kind,
    text: last.text,
    deleted: last.deleted,
    attachmentName: last.attachment?.name,
  });
  if (last.kind === "system") {
    return body;
  }
  if (last.senderId === meId) {
    return `You: ${body}`;
  }
  if (chat.type === "group") {
    const sender = contacts.get(last.senderId);
    return `${sender ? firstName(sender.name) : "Someone"}: ${body}`;
  }
  return body;
}

export function senderLabel(senderId: string, meId: string, contacts: ContactMap) {
  if (senderId === meId) {
    return "You";
  }
  if (senderId === SYSTEM_SENDER) {
    return "Dovetalk";
  }
  return contacts.get(senderId)?.name ?? "Someone";
}
