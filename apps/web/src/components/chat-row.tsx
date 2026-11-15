"use client";

import { BellOff, Pin } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { Avatar } from "@/components/ui/avatar";
import type { ChatDto } from "@/lib/api/types";
import { useMe } from "@/lib/auth/me";
import { chatMeta, lastActivity, previewOf } from "@/lib/chat-helpers";
import { useNow } from "@/lib/hooks/use-now";
import { useContactsById } from "@/lib/queries/queries";
import { useUi } from "@/lib/stores/ui";
import { cn, formatRelative } from "@/lib/utils";

export function ChatRow({ chat }: { chat: ChatDto }) {
  const me = useMe();
  const contactsById = useContactsById();
  const now = useNow();
  const pathname = usePathname();
  const meta = chatMeta(chat, contactsById);
  const active = pathname === `/chat/${chat.id}`;
  const typingName = useUi((s) => s.typing[chat.id]);
  const hidePreview = !me.preferences.previews && chat.unread > 0;

  return (
    <Link
      aria-current={active ? "page" : undefined}
      className={cn(
        "hover:bg-muted flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors",
        active && "bg-muted",
      )}
      href={`/chat/${chat.id}`}
    >
      <Avatar
        group={meta.group}
        hue={meta.hue}
        name={meta.title}
        online={meta.online}
        src={meta.avatarUrl}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-display truncate text-[15px] font-semibold">{meta.title}</span>
          <span
            className={cn(
              "shrink-0 text-xs",
              chat.unread > 0 && !chat.muted
                ? "text-foreground font-semibold"
                : "text-muted-foreground",
            )}
          >
            {formatRelative(lastActivity(chat), now)}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          {typingName ? (
            <span className="text-primary dark:text-accent truncate text-sm font-medium">
              {meta.group ? `${typingName} is typing…` : "typing…"}
            </span>
          ) : (
            <span className="text-muted-foreground truncate text-sm">
              {hidePreview ? "New message" : previewOf(chat, contactsById, me.id)}
            </span>
          )}
          <span className="flex shrink-0 items-center gap-1.5">
            {chat.muted ? (
              <BellOff aria-label="Muted" className="text-muted-foreground size-3.5" />
            ) : null}
            {chat.pinned ? (
              <Pin aria-label="Pinned" className="text-muted-foreground size-3.5" />
            ) : null}
            {chat.unread > 0 ? (
              <span
                className={cn(
                  "grid h-5 min-w-5 place-items-center rounded-full px-1.5 text-xs font-bold",
                  chat.muted
                    ? "bg-muted-foreground/25 text-foreground"
                    : "bg-accent text-accent-foreground",
                )}
              >
                <span aria-hidden="true">{chat.unread}</span>
                <span className="sr-only">{chat.unread} unread messages</span>
              </span>
            ) : null}
          </span>
        </div>
      </div>
    </Link>
  );
}
