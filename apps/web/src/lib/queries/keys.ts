/** Cache keys for TanStack Query. Messages use their own prefix so chat-list refreshes leave them alone. */
export const keys = {
  me: ["me"] as const,
  contacts: ["contacts"] as const,
  chats: ["chats"] as const,
  messages: (chatId: string) => ["messages", chatId] as const,
  statuses: ["statuses"] as const,
};
