import type { QueryClient } from "@tanstack/react-query";

import type {
  ChatDto,
  ContactDto,
  ServerEventName,
  ServerEvents,
  StatusDto,
} from "@/lib/api/types";
import { SYSTEM_SENDER } from "@/lib/api/types";
import {
  appendMessage,
  mapMessages,
  patchChat,
  updateChats,
  upsertChat,
} from "@/lib/queries/cache";
import { keys } from "@/lib/queries/keys";

export type ServerEventMessage = {
  [K in ServerEventName]: { event: K; payload: ServerEvents[K] };
}[ServerEventName];

export interface SyncContext {
  /** The chat open on screen, if any. */
  activeChatId: string | null;
  meId: string;
}

/** Things the caller should do after the cache was updated. */
export type SyncEffect =
  | { type: "chime" }
  | { type: "markRead"; chatId: string }
  | { type: "typing"; chatId: string; name: string | null };

/**
 * Applies one event from the server to the query cache and says what else to do about it.
 * Messages and chats are matched by id, so an event for something already there is harmless.
 */
export function applyServerEvent(
  qc: QueryClient,
  ev: ServerEventMessage,
  ctx: SyncContext,
): SyncEffect[] {
  const effects: SyncEffect[] = [];

  switch (ev.event) {
    case "message:new": {
      const { message } = ev.payload;
      appendMessage(qc, message);

      const chats = qc.getQueryData<ChatDto[]>(keys.chats);
      const chat = chats?.find((c) => c.id === message.chatId);
      if (chats && !chat) {
        // A chat created elsewhere, for example on another device.
        void qc.invalidateQueries({ queryKey: keys.chats });
      } else if (chat && message.createdAt >= (chat.lastMessage?.createdAt ?? 0)) {
        patchChat(qc, chat.id, (c) => ({ ...c, lastMessage: message }));
      }

      const incoming = message.senderId !== ctx.meId && message.senderId !== SYSTEM_SENDER;
      if (incoming) {
        if (!chat?.muted) {
          effects.push({ type: "chime" });
        }
        if (ctx.activeChatId === message.chatId) {
          patchChat(qc, message.chatId, (c) => ({ ...c, unread: 0 }));
          effects.push({ type: "markRead", chatId: message.chatId });
        }
      }
      break;
    }

    case "message:updated": {
      const { message } = ev.payload;
      mapMessages(qc, message.chatId, (m) => (m.id === message.id ? message : m));
      patchChat(qc, message.chatId, (c) =>
        c.lastMessage?.id === message.id ? { ...c, lastMessage: message } : c,
      );
      break;
    }

    case "chat:updated": {
      const { chat } = ev.payload;
      if (ctx.activeChatId === chat.id && chat.unread > 0) {
        // The person is looking at this chat, so nothing in it is unread.
        upsertChat(qc, { ...chat, unread: 0 });
        effects.push({ type: "markRead", chatId: chat.id });
      } else {
        upsertChat(qc, chat);
      }
      break;
    }

    case "chat:removed": {
      const { chatId } = ev.payload;
      updateChats(qc, (chats) => chats.filter((c) => c.id !== chatId));
      qc.removeQueries({ queryKey: keys.messages(chatId) });
      break;
    }

    case "typing": {
      const { chatId, name, isTyping } = ev.payload;
      effects.push({ type: "typing", chatId, name: isTyping ? name : null });
      break;
    }

    case "presence": {
      const { contactId, online } = ev.payload;
      qc.setQueryData<ContactDto[]>(keys.contacts, (old) =>
        old?.map((c) => (c.id === contactId ? { ...c, online } : c)),
      );
      break;
    }

    case "status:new": {
      const { status } = ev.payload;
      qc.setQueryData<StatusDto[]>(keys.statuses, (old) =>
        old && !old.some((s) => s.id === status.id) ? [...old, status] : old,
      );
      break;
    }
  }

  return effects;
}
