"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import {
  EditContactForm,
  ForwardForm,
  GroupInfoForm,
  SettingsForm,
} from "@/components/dialogs-extra";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import { isSavedContact } from "@/lib/chat-helpers";
import { STATUS_COLORS } from "@/lib/constants";
import { useCreateChat, useCreateContact, useCreateStatus } from "@/lib/queries/mutations";
import { useContacts } from "@/lib/queries/queries";
import { useUi } from "@/lib/stores/ui";
import { cn } from "@/lib/utils";

export function Dialogs() {
  const dialog = useUi((s) => s.dialog);
  const closeDialog = useUi((s) => s.closeDialog);
  const onOpenChange = (open: boolean) => {
    if (!open) {
      closeDialog();
    }
  };

  return (
    <>
      <Modal
        description="Choose a contact to start a conversation."
        onOpenChange={onOpenChange}
        open={dialog === "newChat"}
        title="New chat"
      >
        <NewChatForm />
      </Modal>
      <Modal
        description="Name your group and add at least two people."
        onOpenChange={onOpenChange}
        open={dialog === "newGroup"}
        title="Create group"
      >
        <NewGroupForm />
      </Modal>
      <Modal
        description="Share a short update. Your contacts will see it in the status row."
        onOpenChange={onOpenChange}
        open={dialog === "addStatus"}
        title="Add status"
      >
        <AddStatusForm />
      </Modal>
      <Modal
        description="Save a name and phone number to your contacts."
        onOpenChange={onOpenChange}
        open={dialog === "addContact"}
        title="Add contact"
      >
        <AddContactForm />
      </Modal>
      <Modal
        description="Your profile and preferences."
        onOpenChange={onOpenChange}
        open={dialog === "settings"}
        title="Settings"
      >
        <SettingsForm />
      </Modal>
      <Modal
        description="Choose the chats to send this message to."
        onOpenChange={onOpenChange}
        open={dialog === "forward"}
        title="Forward message"
      >
        <ForwardForm />
      </Modal>
      <Modal
        description="Rename the group and manage who is in it."
        onOpenChange={onOpenChange}
        open={dialog === "groupInfo"}
        title="Group info"
      >
        <GroupInfoForm />
      </Modal>
      <Modal
        description="Update this contact's name, number and about line."
        onOpenChange={onOpenChange}
        open={dialog === "editContact"}
        title="Edit contact"
      >
        <EditContactForm />
      </Modal>
    </>
  );
}

function NewChatForm() {
  const router = useRouter();
  const closeDialog = useUi((s) => s.closeDialog);
  const { data } = useContacts();
  const createChat = useCreateChat();
  const [query, setQuery] = useState("");

  const contacts = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data ?? [])
      .filter(isSavedContact)
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data, query]);

  return (
    <div>
      <Input
        aria-label="Search contacts"
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search contacts"
        value={query}
      />
      <div className="scroll-thin -mx-2 mt-3 max-h-72 overflow-y-auto px-2">
        {contacts.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            No contacts match “{query}”.
          </p>
        ) : (
          contacts.map((c) => (
            <button
              className="hover:bg-muted flex w-full items-center gap-3 rounded-xl px-2 py-2 text-left transition-colors"
              disabled={createChat.isPending}
              key={c.id}
              onClick={() =>
                createChat.mutate(
                  { type: "direct", contactId: c.id },
                  {
                    onSuccess: (chat) => {
                      closeDialog();
                      router.push(`/chat/${chat.id}`);
                    },
                  },
                )
              }
              type="button"
            >
              <Avatar hue={c.hue} name={c.name} size="sm" src={c.avatarUrl ?? undefined} />
              <span className="font-display text-[15px] font-semibold">{c.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function NewGroupForm() {
  const router = useRouter();
  const closeDialog = useUi((s) => s.closeDialog);
  const { data } = useContacts();
  const createChat = useCreateChat();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  const contacts = useMemo(
    () => (data ?? []).filter(isSavedContact).sort((a, b) => a.name.localeCompare(b.name)),
    [data],
  );
  const canCreate = name.trim().length > 0 && selected.length >= 2 && !createChat.isPending;

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!canCreate) {
          return;
        }
        createChat.mutate(
          { type: "group", name: name.trim(), memberIds: selected },
          {
            onSuccess: (chat) => {
              closeDialog();
              router.push(`/chat/${chat.id}`);
            },
          },
        );
      }}
    >
      <label className="block text-sm font-medium" htmlFor="group-name">
        Group name
      </label>
      <Input
        autoFocus
        className="mt-1.5"
        id="group-name"
        maxLength={40}
        onChange={(e) => setName(e.target.value)}
        placeholder="Weekend plans"
        value={name}
      />

      <fieldset className="mt-4">
        <legend className="text-sm font-medium">
          Members{" "}
          <span className="text-muted-foreground font-normal">({selected.length} selected)</span>
        </legend>
        <div className="scroll-thin -mx-2 mt-1.5 max-h-56 overflow-y-auto px-2">
          {contacts.map((c) => (
            <label
              className="hover:bg-muted flex cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 transition-colors"
              key={c.id}
            >
              <input
                checked={selected.includes(c.id)}
                className="size-4 accent-[hsl(var(--primary))]"
                onChange={() => toggle(c.id)}
                type="checkbox"
              />
              <Avatar hue={c.hue} name={c.name} size="xs" />
              <span className="text-sm">{c.name}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div className="mt-5 flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs">
          {canCreate ? "Ready to create." : "Add a name and pick at least two people."}
        </p>
        <Button disabled={!canCreate} type="submit" variant="primary">
          Create group
        </Button>
      </div>
    </form>
  );
}

function AddStatusForm() {
  const closeDialog = useUi((s) => s.closeDialog);
  const createStatus = useCreateStatus();
  const [text, setText] = useState("");
  const [color, setColor] = useState(0);
  const palette = STATUS_COLORS[color];

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) {
          return;
        }
        createStatus.mutate({ text: text.trim(), color }, { onSuccess: closeDialog });
      }}
    >
      <div
        className="font-display grid h-40 place-items-center rounded-xl px-6 text-center text-2xl leading-tight font-semibold"
        style={{ background: palette.bg, color: palette.fg }}
      >
        {text.trim() || "Type your update"}
      </div>

      <label className="mt-4 block text-sm font-medium" htmlFor="status-text">
        Status text
      </label>
      <textarea
        autoFocus
        className="border-border bg-surface placeholder:text-muted-foreground mt-1.5 w-full resize-none rounded-[10px] border px-3 py-2 text-sm"
        id="status-text"
        maxLength={120}
        onChange={(e) => setText(e.target.value)}
        placeholder="What is on your mind?"
        rows={2}
        value={text}
      />
      <p className="text-muted-foreground mt-1 text-right text-xs tabular-nums">
        {text.length}/120
      </p>

      <fieldset aria-label="Background color" className="mt-2 flex min-w-0 items-center gap-2">
        {STATUS_COLORS.map((c, i) => (
          <button
            aria-label={`Background ${i + 1}`}
            aria-pressed={color === i}
            className={cn(
              "border-border ring-offset-surface size-8 rounded-full border ring-offset-2",
              color === i && "ring-foreground ring-2",
            )}
            key={c.bg}
            onClick={() => setColor(i)}
            style={{ background: c.bg }}
            type="button"
          />
        ))}
      </fieldset>

      <div className="mt-5 flex justify-end">
        <Button disabled={!text.trim() || createStatus.isPending} type="submit" variant="primary">
          Post status
        </Button>
      </div>
    </form>
  );
}

function AddContactForm() {
  const router = useRouter();
  const closeDialog = useUi((s) => s.closeDialog);
  const createContact = useCreateContact();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [errors, setErrors] = useState<{ name?: string; phone?: string }>({});

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const next: typeof errors = {};
        if (!name.trim()) {
          next.name = "Enter a name.";
        }
        if (phone.replace(/\D/gu, "").length < 7) {
          next.phone = "Enter a phone number with at least 7 digits.";
        }
        setErrors(next);
        if (Object.keys(next).length > 0) {
          return;
        }
        createContact.mutate(
          { name: name.trim(), phone: phone.trim() },
          {
            onSuccess: (contact) => {
              closeDialog();
              router.push(`/contacts/${contact.id}`);
            },
          },
        );
      }}
    >
      <label className="block text-sm font-medium" htmlFor="contact-name">
        Name
      </label>
      <Input
        aria-describedby={errors.name ? "contact-name-error" : undefined}
        aria-invalid={!!errors.name}
        autoFocus
        className="mt-1.5"
        id="contact-name"
        onChange={(e) => setName(e.target.value)}
        value={name}
      />
      {errors.name ? (
        <p className="text-danger mt-1 text-xs" id="contact-name-error">
          {errors.name}
        </p>
      ) : null}

      <label className="mt-4 block text-sm font-medium" htmlFor="contact-phone">
        Phone number
      </label>
      <Input
        aria-describedby={errors.phone ? "contact-phone-error" : undefined}
        aria-invalid={!!errors.phone}
        className="mt-1.5"
        id="contact-phone"
        onChange={(e) => setPhone(e.target.value)}
        placeholder="(555) 010-0100"
        type="tel"
        value={phone}
      />
      {errors.phone ? (
        <p className="text-danger mt-1 text-xs" id="contact-phone-error">
          {errors.phone}
        </p>
      ) : null}

      <div className="mt-5 flex justify-end">
        <Button disabled={createContact.isPending} type="submit" variant="primary">
          Add contact
        </Button>
      </div>
    </form>
  );
}
