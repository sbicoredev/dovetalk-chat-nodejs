"use client";

import { useMemo } from "react";

import { ListError, ListSkeleton } from "@/components/chat-list-state";
import { ChatRow } from "@/components/chat-row";
import { errorMessage } from "@/lib/api/errors";
import { compareChats } from "@/lib/chat-helpers";
import { useChats } from "@/lib/queries/queries";

export function ArchivePanel() {
  const chatsQuery = useChats();
  const chats = useMemo(
    () => (chatsQuery.data ?? []).filter((c) => c.archived).sort(compareChats),
    [chatsQuery.data],
  );

  return (
    <>
      <header className="px-5 pt-5 pb-3">
        <h1 className="font-display text-2xl font-semibold">Archived messages</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Archived chats stay quiet until you open them.
        </p>
      </header>
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {chatsQuery.isPending ? (
          <ListSkeleton />
        ) : chatsQuery.isError ? (
          <ListError
            message={errorMessage(chatsQuery.error)}
            onRetry={() => void chatsQuery.refetch()}
          />
        ) : chats.length === 0 ? (
          <p className="text-muted-foreground px-4 py-10 text-center text-sm">
            Nothing archived yet. Use the menu in a chat to archive it.
          </p>
        ) : (
          <ul>
            {chats.map((chat) => (
              <li key={chat.id}>
                <ChatRow chat={chat} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
