"use client";

import { Search, UserPlus } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo, useState } from "react";

import { ListError, ListSkeleton } from "@/components/chat-list-state";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/errors";
import { isSavedContact } from "@/lib/chat-helpers";
import { useContacts } from "@/lib/queries/queries";
import { useUi } from "@/lib/stores/ui";
import { cn } from "@/lib/utils";

export function ContactsPanel() {
  const openDialog = useUi((s) => s.openDialog);
  const contactsQuery = useContacts();
  const pathname = usePathname();
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const sorted = (contactsQuery.data ?? [])
      .filter(isSavedContact)
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.phone.includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    const byLetter = new Map<string, typeof sorted>();
    for (const c of sorted) {
      const letter = c.name[0].toUpperCase();
      byLetter.set(letter, [...(byLetter.get(letter) ?? []), c]);
    }
    return [...byLetter.entries()];
  }, [contactsQuery.data, query]);

  return (
    <>
      <header className="flex items-center justify-between px-5 pt-5 pb-3">
        <h1 className="font-display text-2xl font-semibold">Contacts</h1>
        <Button onClick={() => openDialog("addContact")} size="sm" variant="primary">
          <UserPlus className="size-4" />
          Add contact
        </Button>
      </header>

      <div className="px-5 pb-3">
        <div className="relative">
          <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
          <Input
            aria-label="Search contacts"
            className="bg-background pl-9"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or number"
            type="search"
            value={query}
          />
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        {contactsQuery.isPending ? (
          <ListSkeleton />
        ) : contactsQuery.isError ? (
          <ListError
            message={errorMessage(contactsQuery.error)}
            onRetry={() => void contactsQuery.refetch()}
          />
        ) : groups.length === 0 ? (
          <p className="text-muted-foreground px-4 py-10 text-center text-sm">
            {query
              ? `No contacts match “${query}”. Check the spelling or add them as a new contact.`
              : "No contacts yet. Choose Add contact to save someone."}
          </p>
        ) : (
          groups.map(([letter, contacts]) => (
            <section aria-label={`Contacts starting with ${letter}`} key={letter}>
              <h2 className="font-display text-muted-foreground px-3 pt-3 pb-1 text-sm font-semibold">
                {letter}
              </h2>
              {contacts.map((c) => {
                const active = pathname === `/contacts/${c.id}`;
                return (
                  <Link
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "hover:bg-muted flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors",
                      active && "bg-muted",
                    )}
                    href={`/contacts/${c.id}`}
                    key={c.id}
                  >
                    <Avatar
                      hue={c.hue}
                      name={c.name}
                      online={c.online}
                      src={c.avatarUrl ?? undefined}
                    />
                    <div className="min-w-0">
                      <p className="font-display truncate text-[15px] font-semibold">{c.name}</p>
                      <p className="text-muted-foreground truncate text-sm">
                        {c.phone}
                        {c.blocked ? <span className="text-danger ml-2">Blocked</span> : null}
                      </p>
                    </div>
                  </Link>
                );
              })}
            </section>
          ))
        )}
      </div>
    </>
  );
}
