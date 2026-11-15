"use client";

import { MessageSquarePlus, Plus, Search, Users } from "lucide-react";
import { useMemo, useState } from "react";

import { ListError, ListSkeleton } from "@/components/chat-list-state";
import { ChatRow } from "@/components/chat-row";
import { StatusStrip } from "@/components/status-strip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu";
import { errorMessage } from "@/lib/api/errors";
import { chatMeta, compareChats } from "@/lib/chat-helpers";
import { useChats, useContactsById } from "@/lib/queries/queries";
import { useUi } from "@/lib/stores/ui";

export function ChatsPanel() {
  const openDialog = useUi((s) => s.openDialog);
  const contactsById = useContactsById();
  const chatsQuery = useChats();
  const [query, setQuery] = useState("");

  const chats = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (chatsQuery.data ?? [])
      .filter((c) => !c.archived)
      .filter((c) => {
        if (!q) {
          return true;
        }
        const title = chatMeta(c, contactsById).title.toLowerCase();
        return title.includes(q) || c.lastMessage?.text?.toLowerCase().includes(q);
      })
      .sort(compareChats);
  }, [chatsQuery.data, contactsById, query]);

  return (
    <>
      <header className="flex items-center justify-between px-5 pt-5 pb-3">
        <h1 className="font-display text-2xl font-semibold">Chats</h1>
        <Menu>
          <MenuTrigger render={<Button size="sm" variant="primary" />}>
            <Plus className="size-4" />
            New
          </MenuTrigger>
          <MenuContent>
            <MenuItem
              icon={<MessageSquarePlus className="size-4" />}
              onClick={() => openDialog("newChat")}
            >
              New chat
            </MenuItem>
            <MenuItem icon={<Users className="size-4" />} onClick={() => openDialog("newGroup")}>
              Create group
            </MenuItem>
          </MenuContent>
        </Menu>
      </header>

      <div className="px-5 pb-3">
        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            aria-label="Search chats"
            className="bg-background pl-9"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            type="search"
            value={query}
          />
        </div>
      </div>

      {query ? null : <StatusStrip />}

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
            {query
              ? `No chats match “${query}”. Try a name or a word from the latest message.`
              : "No chats yet. Choose New to start a conversation."}
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
