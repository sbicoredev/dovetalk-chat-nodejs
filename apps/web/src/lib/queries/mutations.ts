"use client";

import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";

import { useApi } from "@/lib/api/context";
import type {
  AttachmentDto,
  ChatDto,
  ContactDto,
  CreateChatInput,
  CreateContactInput,
  CreateStatusInput,
  DeleteScope,
  MeDto,
  ReplyPreview,
  SendMessageInput,
  StatusDto,
  UpdateChatInput,
  UpdateContactInput,
  UpdateMeInput,
} from "@/lib/api/types";

import {
  appendMessage,
  asDeleted,
  type ClientMessage,
  lastLoadedMessage,
  type MessagesData,
  mapMessages,
  patchChat,
  restoreChat,
  snapshotChat,
  toggleReactionIn,
  updateChats,
  upsertChat,
} from "./cache";
import { keys } from "./keys";

const meIdOf = (qc: QueryClient) => qc.getQueryData<MeDto>(keys.me)?.id ?? "";

// ---------------------------------------------------------------------------
// Profile and uploads

export function useUpdateMe() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateMeInput) => api.me.update(input),
    onMutate: async (input) => {
      await qc.cancelQueries({ queryKey: keys.me });
      const previous = qc.getQueryData<MeDto>(keys.me);
      if (previous) {
        qc.setQueryData<MeDto>(keys.me, {
          ...previous,
          ...(input.name !== undefined && { name: input.name }),
          ...(input.about !== undefined && { about: input.about }),
          ...(input.avatarUrl !== undefined && { avatarUrl: input.avatarUrl }),
          preferences: { ...previous.preferences, ...input.preferences },
        });
      }
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) {
        qc.setQueryData(keys.me, context.previous);
      }
    },
    onSuccess: (me) => qc.setQueryData(keys.me, me),
  });
}

export interface UploadInput {
  file: Blob;
  height?: number | null;
  name: string;
  width?: number | null;
}

export function useUploadFile() {
  const api = useApi();
  return useMutation({
    mutationFn: ({ file, name, width, height }: UploadInput) =>
      api.uploads.create(file, { name, width, height }),
  });
}

// ---------------------------------------------------------------------------
// Contacts

export function useCreateContact() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateContactInput) => api.contacts.create(input),
    meta: { silent: true },
    onSuccess: (contact) =>
      qc.setQueryData<ContactDto[]>(keys.contacts, (old) => (old ? [...old, contact] : old)),
  });
}

export function useUpdateContact() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateContactInput }) =>
      api.contacts.update(id, input),
    meta: { silent: true },
    onSuccess: (contact) =>
      qc.setQueryData<ContactDto[]>(keys.contacts, (old) =>
        old?.map((c) => (c.id === contact.id ? contact : c)),
      ),
  });
}

export function useDeleteContact() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.contacts.remove(id),
    onSuccess: (_void, id) => {
      qc.setQueryData<ContactDto[]>(keys.contacts, (old) => old?.filter((c) => c.id !== id));
      // Their chat, group memberships and statuses went with them.
      void qc.invalidateQueries({ queryKey: keys.chats });
      void qc.invalidateQueries({ queryKey: keys.statuses });
    },
  });
}

export function useSetBlocked() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, blocked }: { id: string; blocked: boolean }) =>
      api.contacts.setBlocked(id, blocked),
    onMutate: async ({ id, blocked }) => {
      await qc.cancelQueries({ queryKey: keys.contacts });
      const previous = qc.getQueryData<ContactDto[]>(keys.contacts);
      qc.setQueryData<ContactDto[]>(keys.contacts, (old) =>
        old?.map((c) => (c.id === id ? { ...c, blocked } : c)),
      );
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(keys.contacts, context.previous);
      }
    },
    onSuccess: (contact) =>
      qc.setQueryData<ContactDto[]>(keys.contacts, (old) =>
        old?.map((c) => (c.id === contact.id ? contact : c)),
      ),
  });
}

// ---------------------------------------------------------------------------
// Chats

export function useCreateChat() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateChatInput) => api.chats.create(input),
    onSuccess: (chat) => {
      upsertChat(qc, chat);
      void qc.invalidateQueries({ queryKey: keys.messages(chat.id) });
    },
  });
}

export function useUpdateChat() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateChatInput }) =>
      api.chats.update(id, input),
    onMutate: async ({ id, input }) => {
      await qc.cancelQueries({ queryKey: keys.chats });
      const previous = qc.getQueryData<ChatDto[]>(keys.chats);
      const { archived, pinned, muted } = input;
      patchChat(qc, id, (c) => ({
        ...c,
        ...(archived !== undefined && { archived }),
        ...(pinned !== undefined && { pinned }),
        ...(muted !== undefined && { muted }),
      }));
      return { previous };
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) {
        qc.setQueryData(keys.chats, context.previous);
      }
    },
    onSuccess: (chat, { id, input }) => {
      upsertChat(qc, chat);
      // Renaming a group adds a notice to the conversation.
      if (input.name !== undefined) {
        void qc.invalidateQueries({ queryKey: keys.messages(id) });
      }
    },
  });
}

export function useDeleteChat() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.chats.remove(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: keys.chats });
      const previous = qc.getQueryData<ChatDto[]>(keys.chats);
      updateChats(qc, (chats) => chats.filter((c) => c.id !== id));
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) {
        qc.setQueryData(keys.chats, context.previous);
      }
    },
    onSuccess: (_void, id) => qc.removeQueries({ queryKey: keys.messages(id) }),
  });
}

export function useClearChat() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.chats.clear(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: keys.messages(id) });
      const snapshot = snapshotChat(qc, id);
      qc.setQueryData<MessagesData>(keys.messages(id), {
        pages: [{ items: [], nextCursor: null }],
        pageParams: [null],
      });
      patchChat(qc, id, (c) => ({ ...c, lastMessage: null, unread: 0 }));
      return { snapshot };
    },
    onError: (_error, id, context) => {
      if (context) {
        restoreChat(qc, id, context.snapshot);
      }
    },
  });
}

/** Tells the server the chat was read. Failures are not worth a toast. */
export function useMarkRead() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.chats.markRead(id),
    meta: { silent: true },
    onMutate: (id) => patchChat(qc, id, (c) => (c.unread > 0 ? { ...c, unread: 0 } : c)),
  });
}

export function useAddMembers() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, memberIds }: { id: string; memberIds: string[] }) =>
      api.chats.addMembers(id, memberIds),
    onSuccess: (chat) => {
      upsertChat(qc, chat);
      void qc.invalidateQueries({ queryKey: keys.messages(chat.id) });
    },
  });
}

export function useRemoveMember() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, contactId }: { id: string; contactId: string }) =>
      api.chats.removeMember(id, contactId),
    onSuccess: (chat) => {
      upsertChat(qc, chat);
      void qc.invalidateQueries({ queryKey: keys.messages(chat.id) });
    },
  });
}

// ---------------------------------------------------------------------------
// Messages

export interface SendVars {
  /** Shown in the optimistic bubble before the server answers. */
  attachment?: AttachmentDto | null;
  chatId: string;
  input: SendMessageInput;
  replyTo?: ReplyPreview | null;
}

/**
 * Shows the message at once, then swaps in the server's copy. If sending fails the bubble
 * stays, marked as failed, and calling `mutate` again with the same variables retries it.
 */
export function useSendMessage() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ chatId, input }: SendVars) => api.messages.send(chatId, input),
    onMutate: async ({ chatId, input, attachment, replyTo }) => {
      await qc.cancelQueries({ queryKey: keys.messages(chatId) });
      const optimistic: ClientMessage = {
        id: `pending-${input.clientId}`,
        chatId,
        clientId: input.clientId,
        senderId: meIdOf(qc),
        kind: input.kind,
        text: input.text?.trim() || null,
        duration: input.duration ?? null,
        bars: input.bars ?? null,
        attachment: attachment ?? null,
        createdAt: Date.now(),
        replyTo: replyTo ?? null,
        reactions: {},
        edited: false,
        deleted: false,
        forwarded: false,
        pending: true,
        input,
      };
      appendMessage(qc, optimistic);
      patchChat(qc, chatId, (c) => ({ ...c, lastMessage: optimistic }));
    },
    onSuccess: (message, { chatId }) => {
      appendMessage(qc, message);
      patchChat(qc, chatId, (c) => ({ ...c, lastMessage: message }));
    },
    onError: (_error, { chatId, input }) =>
      mapMessages(qc, chatId, (m) =>
        m.clientId === input.clientId ? { ...m, pending: false, failed: true } : m,
      ),
  });
}

/** Removes a message that failed to send. */
export function discardMessage(qc: QueryClient, chatId: string, clientId: string) {
  mapMessages(qc, chatId, (m) => (m.clientId === clientId ? null : m));
  patchChat(qc, chatId, (c) => ({ ...c, lastMessage: lastLoadedMessage(qc, chatId) }));
}

export function useEditMessage() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, text }: { chatId: string; messageId: string; text: string }) =>
      api.messages.edit(messageId, text),
    onMutate: async ({ chatId, messageId, text }) => {
      await qc.cancelQueries({ queryKey: keys.messages(chatId) });
      const snapshot = snapshotChat(qc, chatId);
      const edit = (m: ClientMessage): ClientMessage => ({
        ...m,
        text: text.trim() || null,
        edited: true,
      });
      mapMessages(qc, chatId, (m) => (m.id === messageId ? edit(m) : m));
      patchChat(qc, chatId, (c) =>
        c.lastMessage?.id === messageId ? { ...c, lastMessage: edit(c.lastMessage) } : c,
      );
      return { snapshot };
    },
    onError: (_error, { chatId }, context) => {
      if (context) {
        restoreChat(qc, chatId, context.snapshot);
      }
    },
    onSuccess: (message, { chatId }) => {
      mapMessages(qc, chatId, (m) => (m.id === message.id ? message : m));
      patchChat(qc, chatId, (c) =>
        c.lastMessage?.id === message.id ? { ...c, lastMessage: message } : c,
      );
    },
  });
}

export function useDeleteMessage() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, scope }: { chatId: string; messageId: string; scope: DeleteScope }) =>
      api.messages.remove(messageId, scope),
    onMutate: async ({ chatId, messageId, scope }) => {
      await qc.cancelQueries({ queryKey: keys.messages(chatId) });
      const snapshot = snapshotChat(qc, chatId);
      if (scope === "me") {
        mapMessages(qc, chatId, (m) => (m.id === messageId ? null : m));
        patchChat(qc, chatId, (c) =>
          c.lastMessage?.id === messageId
            ? { ...c, lastMessage: lastLoadedMessage(qc, chatId) }
            : c,
        );
      } else {
        mapMessages(qc, chatId, (m) => (m.id === messageId ? asDeleted(m) : m));
        patchChat(qc, chatId, (c) =>
          c.lastMessage?.id === messageId ? { ...c, lastMessage: asDeleted(c.lastMessage) } : c,
        );
      }
      return { snapshot };
    },
    onError: (_error, { chatId }, context) => {
      if (context) {
        restoreChat(qc, chatId, context.snapshot);
      }
    },
  });
}

export function useToggleReaction() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, emoji }: { chatId: string; messageId: string; emoji: string }) =>
      api.messages.toggleReaction(messageId, emoji),
    onMutate: async ({ chatId, messageId, emoji }) => {
      await qc.cancelQueries({ queryKey: keys.messages(chatId) });
      const snapshot = snapshotChat(qc, chatId);
      const userId = meIdOf(qc);
      mapMessages(qc, chatId, (m) =>
        m.id === messageId ? { ...m, reactions: toggleReactionIn(m.reactions, emoji, userId) } : m,
      );
      return { snapshot };
    },
    onError: (_error, { chatId }, context) => {
      if (context) {
        restoreChat(qc, chatId, context.snapshot);
      }
    },
    onSuccess: (message, { chatId }) =>
      mapMessages(qc, chatId, (m) => (m.id === message.id ? message : m)),
  });
}

export function useForwardMessage() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ messageId, chatIds }: { messageId: string; chatIds: string[] }) =>
      api.messages.forward(messageId, chatIds),
    onSuccess: (_messages, { chatIds }) => {
      void qc.invalidateQueries({ queryKey: keys.chats });
      for (const id of chatIds) {
        void qc.invalidateQueries({ queryKey: keys.messages(id) });
      }
    },
  });
}

// ---------------------------------------------------------------------------
// Status

export function useCreateStatus() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateStatusInput) => api.statuses.create(input),
    onSuccess: (status) =>
      qc.setQueryData<StatusDto[]>(keys.statuses, (old) => (old ? [...old, status] : old)),
  });
}

export function useDeleteStatus() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.statuses.remove(id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: keys.statuses });
      const previous = qc.getQueryData<StatusDto[]>(keys.statuses);
      qc.setQueryData<StatusDto[]>(keys.statuses, (old) => old?.filter((s) => s.id !== id));
      return { previous };
    },
    onError: (_error, _id, context) => {
      if (context?.previous) {
        qc.setQueryData(keys.statuses, context.previous);
      }
    },
  });
}

export function useMarkStatusSeen() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.statuses.markSeen(id),
    meta: { silent: true },
    onMutate: (id) =>
      qc.setQueryData<StatusDto[]>(keys.statuses, (old) =>
        old?.map((s) => (s.id === id && !s.seen ? { ...s, seen: true } : s)),
      ),
  });
}
