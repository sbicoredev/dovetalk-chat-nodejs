"use client";

import { MessageSquarePlus, UserPlus, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useUi } from "@/lib/stores/ui";

type Variant = "chats" | "contacts" | "archive";

const copy: Record<Variant, { title: string; body: string }> = {
  chats: {
    title: "No conversation selected",
    body: "Pick a chat from the list, or start a new one.",
  },
  contacts: {
    title: "No contact selected",
    body: "Choose a contact to see their details, or add someone new.",
  },
  archive: {
    title: "Archived chats live here",
    body: "Open one from the list to read it. Unarchive it from its menu to bring it back.",
  },
};

export function EmptyState({ variant }: { variant: Variant }) {
  const openDialog = useUi((s) => s.openDialog);
  const { title, body } = copy[variant];

  return (
    <div className="m-auto flex max-w-sm flex-col items-center gap-4 px-6 text-center">
      <svg aria-hidden="true" className="h-28 w-40" viewBox="0 0 160 120">
        <rect className="fill-primary" height="58" rx="22" width="98" x="8" y="10" />
        <path className="fill-primary" d="M30 66 L20 90 L52 68Z" />
        <circle cx="42" cy="39" fill="white" r="5" />
        <circle cx="58" cy="39" fill="white" r="5" />
        <circle cx="74" cy="39" fill="white" r="5" />
        <rect className="fill-accent" height="58" rx="22" width="98" x="54" y="52" />
        <path className="fill-accent" d="M132 108 L146 118 L120 110Z" />
        <rect
          className="fill-accent-foreground"
          height="7"
          opacity="0.8"
          rx="3.5"
          width="58"
          x="74"
          y="74"
        />
        <rect
          className="fill-accent-foreground"
          height="7"
          opacity="0.5"
          rx="3.5"
          width="38"
          x="74"
          y="88"
        />
      </svg>
      <div>
        <h2 className="font-display text-xl font-semibold">{title}</h2>
        <p className="text-muted-foreground mt-1 text-sm">{body}</p>
      </div>
      {variant === "chats" ? (
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => openDialog("newChat")} variant="primary">
            <MessageSquarePlus className="size-4" />
            New chat
          </Button>
          <Button onClick={() => openDialog("newGroup")}>
            <Users className="size-4" />
            Create group
          </Button>
        </div>
      ) : null}
      {variant === "contacts" ? (
        <Button onClick={() => openDialog("addContact")} variant="primary">
          <UserPlus className="size-4" />
          Add contact
        </Button>
      ) : null}
    </div>
  );
}
