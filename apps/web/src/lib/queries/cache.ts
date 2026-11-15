import type { InfiniteData, QueryClient } from "@tanstack/react-query";

import type { ChatDto, MessageDto, SendMessageInput } from "@/lib/api/types";

import { keys } from "./keys";

/** A message as the screen sees it: the server's message plus send state. */
export type ClientMessage = MessageDto & {
  /** Shown right away while the server is still saving it. */
  pending?: boolean;
  /** The server refused it or the network failed. Can be retried. */
  failed?: boolean;
  /** What to send again when retrying. */
  input?: SendMessageInput;
};

export interface ClientMessagePage {
  items: ClientMessage[];
  nextCursor: string | null;
}
export type MessagesData = InfiniteData<ClientMessagePage, string | null>;

/** Pages are stored newest first. This returns every loaded message, oldest first. */
export function flattenMessages(
  data: InfiniteData<ClientMessagePage, unknown> | undefined,
): ClientMessage[] {
  if (!data) {
    return [];
  }
  return data.pages
    .slice()
    .reverse()
    .flatMap((page) => page.items);
}

/** Changes or removes (by returning null) each loaded message of a chat. */
export function mapMessages(
  qc: QueryClient,
  chatId: string,
  fn: (message: ClientMessage) => ClientMessage | null,
) {
  qc.setQueryData<MessagesData>(
    keys.messages(chatId),
    (old) =>
      old && {
        ...old,
        pages: old.pages.map((page) => ({
          ...page,
          items: page.items.flatMap((m) => {
            const next = fn(m);
            return next ? [next] : [];
          }),
        })),
      },
  );
}

/**
 * Adds a message to the newest page. A message that is already there, matched by id or by
 * the sender's clientId, is replaced instead, so a server echo never shows up twice.
 */
export function appendMessage(qc: QueryClient, message: ClientMessage) {
  qc.setQueryData<MessagesData>(keys.messages(message.chatId), (old) => {
    if (!old || old.pages.length === 0) {
      return old;
    }
    const matches = (m: ClientMessage) =>
      m.id === message.id || (!!message.clientId && m.clientId === message.clientId);
    let found = false;
    const pages = old.pages.map((page) => ({
      ...page,
      items: page.items.map((m) => {
        if (!matches(m)) {
          return m;
        }
        found = true;
        return message;
      }),
    }));
    if (found) {
      return { ...old, pages };
    }
    const [first, ...rest] = pages;
    return { ...old, pages: [{ ...first, items: [...first.items, message] }, ...rest] };
  });
}

export function updateChats(qc: QueryClient, fn: (chats: ChatDto[]) => ChatDto[]) {
  qc.setQueryData<ChatDto[]>(keys.chats, (old) => (old ? fn(old) : old));
}

export function patchChat(qc: QueryClient, chatId: string, fn: (chat: ChatDto) => ChatDto) {
  updateChats(qc, (chats) => chats.map((c) => (c.id === chatId ? fn(c) : c)));
}

/** Inserts the chat, or replaces it if it is already in the list. */
export function upsertChat(qc: QueryClient, chat: ChatDto) {
  updateChats(qc, (chats) =>
    chats.some((c) => c.id === chat.id)
      ? chats.map((c) => (c.id === chat.id ? chat : c))
      : [chat, ...chats],
  );
}

/** The newest loaded message of a chat, used after a delete to refresh the list preview. */
export function lastLoadedMessage(qc: QueryClient, chatId: string): ClientMessage | null {
  const all = flattenMessages(qc.getQueryData<MessagesData>(keys.messages(chatId)));
  return all.at(-1) ?? null;
}

/** Saves what the screen shows now, so an optimistic change can be undone. */
export function snapshotChat(qc: QueryClient, chatId: string) {
  return {
    messages: qc.getQueryData<MessagesData>(keys.messages(chatId)),
    chats: qc.getQueryData<ChatDto[]>(keys.chats),
  };
}

export function restoreChat(
  qc: QueryClient,
  chatId: string,
  snapshot: ReturnType<typeof snapshotChat>,
) {
  if (snapshot.messages) {
    qc.setQueryData(keys.messages(chatId), snapshot.messages);
  }
  if (snapshot.chats) {
    qc.setQueryData(keys.chats, snapshot.chats);
  }
}

/** One reaction per person: choosing a new emoji replaces the old one, choosing it again removes it. */
export function toggleReactionIn(
  reactions: Record<string, string[]>,
  emoji: string,
  userId: string,
): Record<string, string[]> {
  const previous = Object.entries(reactions).find(([, who]) => who.includes(userId))?.[0];
  const next: Record<string, string[]> = {};
  for (const [e, who] of Object.entries(reactions)) {
    const rest = who.filter((id) => id !== userId);
    if (rest.length > 0) {
      next[e] = rest;
    }
  }
  if (previous !== emoji) {
    next[emoji] = [...(next[emoji] ?? []), userId];
  }
  return next;
}

/** What a message looks like after "delete for everyone". */
export function asDeleted<T extends MessageDto>(message: T): T {
  return {
    ...message,
    deleted: true,
    text: null,
    attachment: null,
    duration: null,
    bars: null,
    reactions: {},
    forwarded: false,
    edited: false,
  };
}
