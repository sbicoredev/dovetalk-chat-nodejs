"use client";

import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useApi } from "@/lib/api/context";
import type { ContactDto } from "@/lib/api/types";
import { MESSAGE_PAGE_SIZE } from "@/lib/constants";

import { type ClientMessagePage, flattenMessages } from "./cache";
import { keys } from "./keys";

export function useContacts() {
  const api = useApi();
  return useQuery({ queryKey: keys.contacts, queryFn: () => api.contacts.list() });
}

export function useContactsById() {
  const { data } = useContacts();
  return useMemo(() => new Map<string, ContactDto>((data ?? []).map((c) => [c.id, c])), [data]);
}

export function useChats() {
  const api = useApi();
  return useQuery({ queryKey: keys.chats, queryFn: () => api.chats.list() });
}

/** `data` is `undefined` while loading and `null` when the chat doesn't exist. */
export function useChat(chatId: string) {
  const api = useApi();
  return useQuery({
    queryKey: keys.chats,
    queryFn: () => api.chats.list(),
    select: (chats) => chats.find((c) => c.id === chatId) ?? null,
  });
}

/**
 * Messages come in pages, newest page first. `messages` is every loaded message, oldest first.
 * Call `fetchNextPage` to load older ones.
 */
export function useMessages(chatId: string) {
  const api = useApi();
  const query = useInfiniteQuery({
    queryKey: keys.messages(chatId),
    queryFn: ({ pageParam }): Promise<ClientMessagePage> =>
      api.chats.messages(chatId, { before: pageParam, limit: MESSAGE_PAGE_SIZE }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 60_000,
  });
  const messages = useMemo(() => flattenMessages(query.data), [query.data]);
  return { ...query, messages };
}

export function useStatuses() {
  const api = useApi();
  return useQuery({ queryKey: keys.statuses, queryFn: () => api.statuses.list() });
}
