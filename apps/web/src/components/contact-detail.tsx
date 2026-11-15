"use client";

import { ArrowLeft, Ban, MessageCircle, Pencil, Phone, Trash2, Video } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";

import { ListError, ListSkeleton } from "@/components/chat-list-state";
import { NotFoundPanel } from "@/components/not-found-panel";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/errors";
import { useCreateChat, useDeleteContact, useSetBlocked } from "@/lib/queries/mutations";
import { useContacts } from "@/lib/queries/queries";
import { useUi } from "@/lib/stores/ui";

export function ContactDetail() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const startCall = useUi((s) => s.startCall);
  const openDialog = useUi((s) => s.openDialog);
  const contacts = useContacts();
  const createChat = useCreateChat();
  const setBlocked = useSetBlocked();
  const deleteContact = useDeleteContact();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const contact = contacts.data?.find((c) => c.id === id);

  if (contacts.isPending) {
    return <ListSkeleton />;
  }
  if (contacts.isError) {
    return (
      <ListError message={errorMessage(contacts.error)} onRetry={() => void contacts.refetch()} />
    );
  }
  if (!contact) {
    return (
      <NotFoundPanel
        body="This contact is no longer in your list. Go back to see everyone you have saved."
        href="/contacts"
        label="Back to contacts"
        title="Contact not found"
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <header className="px-3 py-3 md:hidden">
        <Link aria-label="Back to contacts" href="/contacts">
          <Button size="icon" tabIndex={-1} variant="ghost">
            <ArrowLeft className="size-5" />
          </Button>
        </Link>
      </header>

      <div className="m-auto flex w-full max-w-sm flex-col items-center gap-5 px-6 py-8 text-center">
        <Avatar
          hue={contact.hue}
          name={contact.name}
          online={contact.online}
          size="xl"
          src={contact.avatarUrl ?? undefined}
        />
        <div>
          <h1 className="font-display text-2xl font-semibold">{contact.name}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{contact.about}</p>
          {contact.blocked ? (
            <p className="text-danger mt-2 text-sm font-medium">You blocked this contact.</p>
          ) : null}
        </div>

        <dl className="border-border bg-surface w-full rounded-xl border px-4 py-3 text-left">
          <dt className="text-muted-foreground text-xs">Phone</dt>
          <dd className="mt-0.5 text-[15px] tabular-nums">{contact.phone}</dd>
        </dl>

        <div className="flex flex-wrap justify-center gap-2">
          <Button
            disabled={createChat.isPending}
            onClick={() =>
              createChat.mutate(
                { type: "direct", contactId: contact.id },
                { onSuccess: (chat) => router.push(`/chat/${chat.id}`) },
              )
            }
            variant="primary"
          >
            <MessageCircle className="size-4" />
            Message
          </Button>
          <Button
            disabled={contact.blocked}
            onClick={() =>
              startCall({ name: contact.name, hue: contact.hue, group: false, mode: "voice" })
            }
          >
            <Phone className="size-4" />
            Voice call
          </Button>
          <Button
            disabled={contact.blocked}
            onClick={() =>
              startCall({ name: contact.name, hue: contact.hue, group: false, mode: "video" })
            }
          >
            <Video className="size-4" />
            Video call
          </Button>
        </div>

        <div className="border-border flex w-full flex-wrap justify-center gap-2 border-t pt-5">
          <Button
            onClick={() => openDialog("editContact", { contactId: contact.id })}
            variant="ghost"
          >
            <Pencil className="size-4" />
            Edit contact
          </Button>
          <Button
            onClick={() => setBlocked.mutate({ id: contact.id, blocked: !contact.blocked })}
            variant="ghost"
          >
            <Ban className="size-4" />
            {contact.blocked ? "Unblock" : "Block"}
          </Button>
          {confirmDelete ? null : (
            <Button className="text-danger" onClick={() => setConfirmDelete(true)} variant="ghost">
              <Trash2 className="size-4" />
              Delete contact
            </Button>
          )}
        </div>

        {confirmDelete ? (
          <div className="border-danger/40 bg-danger/5 w-full rounded-xl border p-4 text-left text-sm">
            <p className="font-medium">Delete {contact.name}?</p>
            <p className="text-muted-foreground mt-1">
              This also removes your chat with them and their status updates. They stay in any
              groups only as a removed member.
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <Button onClick={() => setConfirmDelete(false)} size="sm">
                Keep contact
              </Button>
              <Button
                onClick={() => {
                  deleteContact.mutate(contact.id, { onSuccess: () => router.push("/contacts") });
                }}
                size="sm"
                variant="danger"
              >
                Delete contact
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
