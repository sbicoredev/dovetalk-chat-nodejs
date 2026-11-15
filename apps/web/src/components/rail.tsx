"use client";

import { Archive, type LucideIcon, MessageCircle, Users } from "lucide-react";
import Link from "next/link";

import { ThemeToggle } from "@/components/theme-toggle";
import { Avatar } from "@/components/ui/avatar";
import { useMe } from "@/lib/auth/me";
import { useChats } from "@/lib/queries/queries";
import { useUi } from "@/lib/stores/ui";
import { cn } from "@/lib/utils";

export type Section = "chats" | "contacts" | "archive";

const items: { href: string; key: Section; label: string; icon: LucideIcon }[] = [
  { href: "/", key: "chats", label: "Chats", icon: MessageCircle },
  { href: "/contacts", key: "contacts", label: "Contacts", icon: Users },
  { href: "/archive", key: "archive", label: "Archived messages", icon: Archive },
];

export function Rail({ section, hideOnMobile }: { section: Section; hideOnMobile: boolean }) {
  const me = useMe();
  const openDialog = useUi((s) => s.openDialog);
  const { data: chats = [] } = useChats();
  const unreadChats = chats.filter((c) => !(c.archived || c.muted) && c.unread > 0).length;

  return (
    <nav
      aria-label="Primary"
      className={cn(
        "bg-rail order-last flex h-14 shrink-0 items-center justify-around px-2",
        "md:order-first md:h-full md:w-[72px] md:flex-col md:justify-start md:gap-2 md:px-0 md:py-4",
        hideOnMobile && "hidden md:flex",
      )}
    >
      <Link
        aria-label="Dovetalk home"
        className="bg-accent font-display text-accent-foreground mb-3 hidden size-10 place-items-center rounded-xl text-2xl leading-none font-bold md:grid"
        href="/"
      >
        d
      </Link>

      {items.map(({ href, key, label, icon: Icon }) => {
        const active = section === key;
        return (
          <Link
            aria-current={active ? "page" : undefined}
            aria-label={label}
            className={cn(
              "text-rail-foreground/70 hover:text-rail-foreground relative grid size-11 place-items-center rounded-xl transition-colors hover:bg-white/10",
              active && "text-rail-foreground bg-white/15",
            )}
            href={href}
            key={key}
            title={label}
          >
            <Icon className="size-5" />
            {key === "chats" && unreadChats > 0 ? (
              <span className="bg-accent text-accent-foreground absolute top-1 right-1 grid min-w-4 place-items-center rounded-full px-1 text-[10px] leading-4 font-bold">
                {unreadChats}
              </span>
            ) : null}
          </Link>
        );
      })}

      <div className="hidden flex-1 md:block" />
      <ThemeToggle />
      <button
        aria-label="Settings and profile"
        className="grid size-11 place-items-center rounded-xl transition-colors hover:bg-white/10 md:mt-1"
        onClick={() => openDialog("settings")}
        title="Settings and profile"
        type="button"
      >
        <Avatar hue={me.hue} name={me.name} size="sm" src={me.avatarUrl ?? undefined} />
      </button>
    </nav>
  );
}
