"use client";

import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  Ban,
  Bell,
  BellOff,
  ChevronDown,
  ChevronUp,
  EllipsisVertical,
  Eraser,
  Phone,
  Pin,
  PinOff,
  Search,
  Trash2,
  Video,
  X,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
// biome-ignore lint/correctness/noUnresolvedImports: false positive. Biome's resolver does not see the const exports (Fragment, StrictMode, Suspense) that @types/react declares inside its export= namespace; Fragment is a real export of react.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { ListError, ListSkeleton } from "@/components/chat-list-state";
import { Composer, type EditDraft, type ReplyDraft } from "@/components/composer";
import { MessageBubble, type Quote, TypingBubble } from "@/components/message-bubble";
import { NotFoundPanel } from "@/components/not-found-panel";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu";
import { errorMessage } from "@/lib/api/errors";
import { useMe } from "@/lib/auth/me";
import { chatMeta, describeMessage, isChatBlocked, senderLabel } from "@/lib/chat-helpers";
import { useNow } from "@/lib/hooks/use-now";
import type { ClientMessage } from "@/lib/queries/cache";
import {
  useClearChat,
  useDeleteChat,
  useMarkRead,
  useSetBlocked,
  useUpdateChat,
} from "@/lib/queries/mutations";
import { useChat, useContactsById, useMessages } from "@/lib/queries/queries";
import { notify, useUi } from "@/lib/stores/ui";
import { dayBucket, dayLabel, firstName } from "@/lib/utils";

export function Conversation() {
  const { id } = useParams<{ id: string }>();
  // Keyed by chat so reply, edit and search state reset when you switch chats.
  return <ConversationBody id={id} key={id} />;
}

function ConversationBody({ id }: { id: string }) {
  const router = useRouter();
  const me = useMe();
  const now = useNow();
  const contactsById = useContactsById();
  const startCall = useUi((s) => s.startCall);
  const openDialog = useUi((s) => s.openDialog);
  const setActive = useUi((s) => s.setActiveChat);
  const typingName = useUi((s) => s.typing[id] ?? null);

  const { data: chat } = useChat(id);
  const history = useMessages(id);
  const { messages } = history;
  const updateChat = useUpdateChat();
  const setBlocked = useSetBlocked();
  const clearChat = useClearChat();
  const deleteChat = useDeleteChat();
  const markRead = useMarkRead();

  const scrollerRef = useRef<HTMLDivElement>(null);
  const topRef = useRef<HTMLDivElement>(null);
  /** Scroll position before older messages were added, so the view doesn't jump. */
  const beforePrepend = useRef<{ height: number; top: number } | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [reply, setReply] = useState<ReplyDraft | null>(null);
  const [editing, setEditing] = useState<EditDraft | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [offsetFromEnd, setOffsetFromEnd] = useState(0);
  const [flashId, setFlashId] = useState<string | null>(null);

  useEffect(() => {
    setActive(id);
    return () => setActive(null);
  }, [id, setActive]);

  useEffect(
    () => () => {
      if (flashTimer.current) {
        clearTimeout(flashTimer.current);
      }
    },
    [],
  );

  // Opening a chat, or getting a message while it is open, marks it read.
  const unread = chat?.unread ?? 0;
  const { mutate: markChatRead } = markRead;
  useEffect(() => {
    if (unread > 0) {
      markChatRead(id);
    }
  }, [unread, id, markChatRead]);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = history;
  const loadEarlier = () => {
    const el = scrollerRef.current;
    if (!hasNextPage || isFetchingNextPage) {
      return;
    }
    if (el) {
      beforePrepend.current = { height: el.scrollHeight, top: el.scrollTop };
    }
    void fetchNextPage();
  };
  const loadEarlierRef = useRef(loadEarlier);
  loadEarlierRef.current = loadEarlier;

  // Scrolling to the top loads the next page of older messages.
  useEffect(() => {
    const target = topRef.current;
    const root = scrollerRef.current;
    if (!(target && root) || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          loadEarlierRef.current();
        }
      },
      { root, rootMargin: "120px 0px 0px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [hasNextPage, history.isPending]);

  // After older messages are added above, put the view back where it was.
  const oldestId = messages[0]?.id;
  useLayoutEffect(() => {
    const saved = beforePrepend.current;
    const el = scrollerRef.current;
    if (!(saved && el)) {
      return;
    }
    beforePrepend.current = null;
    el.scrollTop = saved.top + (el.scrollHeight - saved.height);
  }, [oldestId]);

  const searching = findOpen && query.trim().length > 0;

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!(findOpen && q && chat)) {
      return [];
    }
    return messages
      .filter(
        (m) =>
          m.kind !== "system" &&
          !m.deleted &&
          ((m.text ?? "").toLowerCase().includes(q) ||
            (m.attachment?.name ?? "").toLowerCase().includes(q)),
      )
      .map((m) => m.id);
  }, [chat, messages, findOpen, query]);

  const currentIndex = matches.length > 0 ? Math.max(0, matches.length - 1 - offsetFromEnd) : -1;
  const currentMatchId = currentIndex >= 0 ? matches[currentIndex] : null;

  useEffect(() => {
    if (!currentMatchId) {
      return;
    }
    document.getElementById(`msg-${currentMatchId}`)?.scrollIntoView({ block: "center" });
  }, [currentMatchId]);

  // Go to the bottom for new messages only, not when older ones load above.
  const lastId = messages.at(-1)?.id;
  useEffect(() => {
    if (searching) {
      return;
    }
    endRef.current?.scrollIntoView({ block: "end" });
  }, [lastId, typingName, id, searching]);

  if (chat === undefined || history.isPending) {
    return history.isError ? (
      <ListError message={errorMessage(history.error)} onRetry={() => void history.refetch()} />
    ) : (
      <ListSkeleton />
    );
  }
  if (!chat) {
    return (
      <NotFoundPanel
        body="It may have been deleted. Go back to your chats to pick another one."
        href="/"
        label="Back to chats"
        title="This chat is gone"
      />
    );
  }

  const meta = chatMeta(chat, contactsById);
  const contactId = chat.type === "direct" ? chat.memberIds[0] : undefined;
  const contact = contactId ? contactsById.get(contactId) : undefined;
  const blocked = isChatBlocked(chat, contactsById);
  const subtitle = meta.group
    ? ["You", ...chat.memberIds.map((m) => firstName(contactsById.get(m)?.name ?? "Someone"))].join(
        ", ",
      )
    : blocked
      ? "Blocked"
      : meta.online
        ? "Online"
        : "Offline";

  const label = (senderId: string) => senderLabel(senderId, me.id, contactsById);

  const quoteFor = (m: ClientMessage): Quote | undefined => {
    const r = m.replyTo;
    if (!r) {
      return undefined;
    }
    return {
      id: r.id,
      label: label(r.senderId),
      snippet: describeMessage({
        kind: r.kind,
        text: r.text,
        deleted: r.deleted,
        attachmentName: r.text,
      }),
    };
  };

  const jumpTo = (messageId: string) => {
    const el = document.getElementById(`msg-${messageId}`);
    if (!el) {
      notify("That message is further back. Load earlier messages to see it.");
      return;
    }
    el.scrollIntoView({ block: "center" });
    setFlashId(messageId);
    if (flashTimer.current) {
      clearTimeout(flashTimer.current);
    }
    flashTimer.current = setTimeout(() => setFlashId(null), 1400);
  };

  const closeFind = () => {
    setFindOpen(false);
    setQuery("");
    setOffsetFromEnd(0);
  };

  const step = (direction: "older" | "newer") => {
    if (matches.length === 0) {
      return;
    }
    setOffsetFromEnd((offset) => {
      const index = Math.max(0, matches.length - 1 - offset);
      const next =
        direction === "older"
          ? (index - 1 + matches.length) % matches.length
          : (index + 1) % matches.length;
      return matches.length - 1 - next;
    });
  };

  const titleContent = (
    <>
      <Avatar
        group={meta.group}
        hue={meta.hue}
        name={meta.title}
        online={meta.online}
        src={meta.avatarUrl}
      />
      <div className="min-w-0 flex-1">
        <h1 className="font-display truncate text-lg leading-tight font-semibold">{meta.title}</h1>
        <p className="text-muted-foreground truncate text-sm">{subtitle}</p>
      </div>
    </>
  );
  const titleClass =
    "-m-1 flex min-w-0 flex-1 items-center gap-3 rounded-xl p-1 text-left transition-colors hover:bg-muted/60";

  let lastBucket = -1;

  return (
    <>
      <header className="border-border bg-surface flex items-center gap-1.5 border-b px-3 py-3 md:gap-2 md:px-5">
        <Link aria-label="Back to chats" className="md:hidden" href="/">
          <Button size="icon" tabIndex={-1} variant="ghost">
            <ArrowLeft className="size-5" />
          </Button>
        </Link>

        {meta.group ? (
          <button
            aria-label={`Group info for ${meta.title}`}
            className={titleClass}
            onClick={() => openDialog("groupInfo", { chatId: chat.id })}
            type="button"
          >
            {titleContent}
          </button>
        ) : contact ? (
          <Link
            aria-label={`Contact info for ${meta.title}`}
            className={titleClass}
            href={`/contacts/${contact.id}`}
          >
            {titleContent}
          </Link>
        ) : (
          <div className={titleClass}>{titleContent}</div>
        )}

        <Button
          aria-label="Search in chat"
          aria-pressed={findOpen}
          onClick={() => (findOpen ? closeFind() : setFindOpen(true))}
          size="icon"
          variant="ghost"
        >
          <Search className="size-5" />
        </Button>
        <Button
          aria-label="Voice call"
          disabled={blocked}
          onClick={() =>
            startCall({ name: meta.title, hue: meta.hue, group: meta.group, mode: "voice" })
          }
          size="icon"
          variant="ghost"
        >
          <Phone className="size-5" />
        </Button>
        <Button
          aria-label="Video call"
          disabled={blocked}
          onClick={() =>
            startCall({ name: meta.title, hue: meta.hue, group: meta.group, mode: "video" })
          }
          size="icon"
          variant="ghost"
        >
          <Video className="size-5" />
        </Button>
        <Menu>
          <MenuTrigger render={<Button aria-label="Chat options" size="icon" variant="ghost" />}>
            <EllipsisVertical className="size-5" />
          </MenuTrigger>
          <MenuContent>
            <MenuItem
              icon={chat.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />}
              onClick={() => updateChat.mutate({ id: chat.id, input: { pinned: !chat.pinned } })}
            >
              {chat.pinned ? "Unpin chat" : "Pin chat"}
            </MenuItem>
            <MenuItem
              icon={chat.muted ? <Bell className="size-4" /> : <BellOff className="size-4" />}
              onClick={() => updateChat.mutate({ id: chat.id, input: { muted: !chat.muted } })}
            >
              {chat.muted ? "Unmute notifications" : "Mute notifications"}
            </MenuItem>
            <MenuItem
              icon={
                chat.archived ? (
                  <ArchiveRestore className="size-4" />
                ) : (
                  <Archive className="size-4" />
                )
              }
              onClick={() => {
                updateChat.mutate({ id: chat.id, input: { archived: !chat.archived } });
                if (!chat.archived) {
                  router.push("/");
                }
              }}
            >
              {chat.archived ? "Unarchive chat" : "Archive chat"}
            </MenuItem>
            {contact ? (
              <MenuItem
                icon={<Ban className="size-4" />}
                onClick={() => setBlocked.mutate({ id: contact.id, blocked: !contact.blocked })}
              >
                {contact.blocked ? "Unblock contact" : "Block contact"}
              </MenuItem>
            ) : null}
            <MenuSeparator />
            <MenuItem
              icon={<Eraser className="size-4" />}
              onClick={() => clearChat.mutate(chat.id)}
            >
              Clear messages
            </MenuItem>
            <MenuItem
              danger
              icon={<Trash2 className="size-4" />}
              onClick={() => {
                deleteChat.mutate(chat.id);
                router.push("/");
              }}
            >
              Delete chat
            </MenuItem>
          </MenuContent>
        </Menu>
      </header>

      {findOpen ? (
        <div className="border-border bg-surface flex items-center gap-2 border-b px-4 py-2">
          <Search className="text-muted-foreground size-4 shrink-0" />
          <input
            aria-label="Search in this chat"
            autoFocus
            className="placeholder:text-muted-foreground h-9 min-w-0 flex-1 bg-transparent text-sm focus-visible:outline-none"
            onChange={(e) => {
              setQuery(e.target.value);
              setOffsetFromEnd(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                step(e.shiftKey ? "newer" : "older");
              }
              if (e.key === "Escape") {
                closeFind();
              }
            }}
            placeholder="Search in this chat"
            type="search"
            value={query}
          />
          <span className="text-muted-foreground shrink-0 text-xs tabular-nums" role="status">
            {query.trim()
              ? matches.length > 0
                ? `${currentIndex + 1} of ${matches.length}`
                : "No matches"
              : ""}
          </span>
          <Button
            aria-label="Previous match"
            disabled={matches.length === 0}
            onClick={() => step("older")}
            size="icon-sm"
            variant="ghost"
          >
            <ChevronUp className="size-4" />
          </Button>
          <Button
            aria-label="Next match"
            disabled={matches.length === 0}
            onClick={() => step("newer")}
            size="icon-sm"
            variant="ghost"
          >
            <ChevronDown className="size-4" />
          </Button>
          <Button aria-label="Close search" onClick={closeFind} size="icon-sm" variant="ghost">
            <X className="size-4" />
          </Button>
        </div>
      ) : null}

      <div
        className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4 md:px-8"
        ref={scrollerRef}
      >
        <div aria-hidden="true" ref={topRef} />
        {history.hasNextPage ? (
          <div className="mb-3 flex justify-center">
            <Button
              disabled={isFetchingNextPage}
              onClick={loadEarlier}
              size="sm"
              variant="secondary"
            >
              {isFetchingNextPage ? "Loading…" : "Load earlier messages"}
            </Button>
          </div>
        ) : null}
        {messages.length === 0 ? (
          <p className="text-muted-foreground mx-auto mt-10 max-w-xs text-center text-sm">
            No messages yet. Say hello to {meta.title}.
          </p>
        ) : null}

        {messages.map((message, i) => {
          const bucket = dayBucket(message.createdAt, now);
          const showDay = bucket !== lastBucket;
          lastBucket = bucket;
          const prev = messages[i - 1];
          const next = messages[i + 1];
          const joinsPrev =
            !!prev &&
            prev.senderId === message.senderId &&
            prev.kind !== "system" &&
            dayBucket(prev.createdAt, now) === bucket;
          const joinsNext =
            !!next &&
            next.senderId === message.senderId &&
            next.kind !== "system" &&
            dayBucket(next.createdAt, now) === bucket;

          return (
            <Fragment key={message.id}>
              {showDay ? (
                <div className="my-4 flex justify-center first:mt-0">
                  <span className="border-border bg-surface text-muted-foreground rounded-full border px-3 py-1 text-xs">
                    {dayLabel(bucket)}
                  </span>
                </div>
              ) : null}
              <MessageBubble
                chatId={chat.id}
                firstInRun={!joinsPrev}
                flash={message.id === flashId}
                group={meta.group}
                highlight={searching ? query : ""}
                isCurrentMatch={message.id === currentMatchId}
                lastInRun={!joinsNext}
                message={message}
                mine={message.senderId === me.id}
                onEdit={(m) => {
                  setReply(null);
                  setEditing({ id: m.id, text: m.text ?? "", allowEmpty: m.kind !== "text" });
                }}
                onForward={(m) => openDialog("forward", { chatId: chat.id, messageId: m.id })}
                onJumpTo={jumpTo}
                onReply={(m) => {
                  setEditing(null);
                  setReply({
                    preview: {
                      id: m.id,
                      senderId: m.senderId,
                      kind: m.kind,
                      text: m.text ?? m.attachment?.name ?? null,
                      deleted: m.deleted,
                    },
                    label: label(m.senderId),
                    snippet: describeMessage({
                      kind: m.kind,
                      text: m.text,
                      deleted: m.deleted,
                      attachmentName: m.attachment?.name,
                    }),
                  });
                }}
                quote={quoteFor(message)}
                sender={contactsById.get(message.senderId)}
              />
            </Fragment>
          );
        })}

        {typingName ? <TypingBubble name={typingName} /> : null}
        <div ref={endRef} />
      </div>

      {blocked && contact ? (
        <div className="border-border bg-surface flex items-center justify-between gap-3 border-t px-4 py-3 text-sm">
          <p>You blocked {contact.name}. Unblock to send messages.</p>
          <Button
            onClick={() => setBlocked.mutate({ id: contact.id, blocked: false })}
            size="sm"
            variant="primary"
          >
            Unblock
          </Button>
        </div>
      ) : (
        <Composer
          chatId={chat.id}
          editing={editing}
          onCancelEdit={() => setEditing(null)}
          onCancelReply={() => setReply(null)}
          reply={reply}
        />
      )}
    </>
  );
}
