"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Camera, UserMinus, UserPlus } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { isMockApi } from "@/lib/api";
import { useMock } from "@/lib/api/context";
import { errorMessage } from "@/lib/api/errors";
import { useMe } from "@/lib/auth/me";
import { chatMeta, compareChats, isChatBlocked, isSavedContact } from "@/lib/chat-helpers";
import { prepareAvatar } from "@/lib/files";
import { useLogout } from "@/lib/queries/auth";
import {
  useAddMembers,
  useForwardMessage,
  useRemoveMember,
  useSetBlocked,
  useUpdateChat,
  useUpdateContact,
  useUpdateMe,
  useUploadFile,
} from "@/lib/queries/mutations";
import { useChats, useContacts, useContactsById } from "@/lib/queries/queries";
import { notify, useUi } from "@/lib/stores/ui";

export function SettingsForm() {
  const me = useMe();
  const closeDialog = useUi((s) => s.closeDialog);
  const qc = useQueryClient();
  const mock = useMock();
  const updateMe = useUpdateMe();
  const upload = useUploadFile();
  const logout = useLogout();
  const setBlocked = useSetBlocked();
  const { data: contacts = [] } = useContacts();
  const settings = {
    ...me.preferences,
    name: me.name,
    about: me.about,
    hue: me.hue,
    avatarUrl: me.avatarUrl,
  };
  const [name, setName] = useState(me.name);
  const [about, setAbout] = useState(me.about);
  const [error, setError] = useState("");
  const [confirmReset, setConfirmReset] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const blocked = contacts.filter((c) => c.blocked);

  const dirty = name.trim() !== settings.name || about.trim() !== settings.about;

  const saveProfile = () => {
    if (!name.trim()) {
      setError("Enter a name.");
      return;
    }
    setError("");
    updateMe.mutate(
      { name: name.trim(), about: about.trim() },
      { onSuccess: () => notify("Profile saved") },
    );
  };

  const pickPhoto = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    try {
      const blob = await prepareAvatar(file);
      const uploaded = await upload.mutateAsync({
        file: blob,
        name: "avatar.jpg",
        width: 256,
        height: 256,
      });
      updateMe.mutate({ avatarUrl: uploaded.url });
    } catch (e) {
      notify(errorMessage(e));
    }
  };

  return (
    <div className="space-y-6">
      <section aria-label="Profile" className="space-y-3">
        <div className="flex items-center gap-4">
          <Avatar
            hue={settings.hue}
            name={name || "You"}
            size="lg"
            src={settings.avatarUrl ?? undefined}
          />
          <div className="flex flex-wrap gap-2">
            <input
              accept="image/*"
              aria-label="Choose a profile photo"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                void pickPhoto(file);
              }}
              ref={fileRef}
              type="file"
            />
            <Button onClick={() => fileRef.current?.click()} size="sm">
              <Camera className="size-4" />
              {settings.avatarUrl ? "Change photo" : "Add photo"}
            </Button>
            {settings.avatarUrl ? (
              <Button
                onClick={() => updateMe.mutate({ avatarUrl: null })}
                size="sm"
                variant="ghost"
              >
                Remove photo
              </Button>
            ) : null}
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium" htmlFor="profile-name">
            Your name
          </label>
          <Input
            aria-describedby={error ? "profile-name-error" : undefined}
            aria-invalid={!!error}
            className="mt-1.5"
            id="profile-name"
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            value={name}
          />
          {error ? (
            <p className="text-danger mt-1 text-xs" id="profile-name-error">
              {error}
            </p>
          ) : null}
        </div>
        <div>
          <label className="block text-sm font-medium" htmlFor="profile-about">
            About
          </label>
          <Input
            className="mt-1.5"
            id="profile-about"
            maxLength={80}
            onChange={(e) => setAbout(e.target.value)}
            value={about}
          />
        </div>
        <div className="flex justify-end">
          <Button disabled={!dirty} onClick={saveProfile} size="sm" variant="primary">
            Save profile
          </Button>
        </div>
      </section>

      <section aria-label="Preferences" className="border-border space-y-1 border-t pt-4">
        <h3 className="font-display pb-1 text-sm font-semibold">Preferences</h3>
        {(
          [
            ["sounds", "Message sounds", "Play a chime when a new message arrives."],
            [
              "previews",
              "Message previews",
              "Show message text in the chat list. Off shows “New message”.",
            ],
            [
              "enterToSend",
              "Enter sends message",
              "Off means Ctrl+Enter sends and Enter adds a new line.",
            ],
          ] as const
        ).map(([key, label, hint]) => (
          <div className="flex items-center justify-between gap-4 py-2" key={key}>
            <div>
              <label className="text-sm font-medium" htmlFor={`pref-${key}`}>
                {label}
              </label>
              <p className="text-muted-foreground text-xs">{hint}</p>
            </div>
            <Switch
              checked={settings[key]}
              id={`pref-${key}`}
              onCheckedChange={(checked) => updateMe.mutate({ preferences: { [key]: checked } })}
            />
          </div>
        ))}
      </section>

      <section aria-label="Blocked contacts" className="border-border border-t pt-4">
        <h3 className="font-display pb-2 text-sm font-semibold">Blocked contacts</h3>
        {blocked.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No one is blocked. Block someone from their contact page or a chat menu.
          </p>
        ) : (
          <ul className="space-y-1">
            {blocked.map((c) => (
              <li className="flex items-center gap-3" key={c.id}>
                <Avatar hue={c.hue} name={c.name} size="xs" src={c.avatarUrl ?? undefined} />
                <span className="flex-1 text-sm">{c.name}</span>
                <Button onClick={() => setBlocked.mutate({ id: c.id, blocked: false })} size="sm">
                  Unblock
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {isMockApi && mock ? (
        <section aria-label="Demo data" className="border-border border-t pt-4">
          <h3 className="font-display pb-1 text-sm font-semibold">Demo data</h3>
          <p className="text-muted-foreground text-sm">
            Your chats, contacts and settings are saved in this browser. Reset to start over with
            the original demo data.
          </p>
          {confirmReset ? (
            <div className="border-danger/40 bg-danger/5 mt-3 flex items-center justify-between gap-3 rounded-xl border p-3 text-sm">
              <span>Erase everything you changed?</span>
              <div className="flex gap-2">
                <Button onClick={() => setConfirmReset(false)} size="sm">
                  Cancel
                </Button>
                <Button
                  onClick={() => {
                    mock.reset();
                    void qc.invalidateQueries();
                    setConfirmReset(false);
                    closeDialog();
                    notify("Demo data reset");
                  }}
                  size="sm"
                  variant="danger"
                >
                  Reset
                </Button>
              </div>
            </div>
          ) : (
            <Button className="mt-3" onClick={() => setConfirmReset(true)} size="sm">
              Reset demo data
            </Button>
          )}
        </section>
      ) : null}

      <div className="flex justify-between gap-2">
        <Button
          disabled={logout.isPending}
          onClick={() => {
            closeDialog();
            logout.mutate();
          }}
        >
          Sign out
        </Button>
        <Button onClick={closeDialog} variant="primary">
          Done
        </Button>
      </div>
    </div>
  );
}

export function ForwardForm() {
  const contactsById = useContactsById();
  const dialogData = useUi((s) => s.dialogData);
  const closeDialog = useUi((s) => s.closeDialog);
  const { data: allChats } = useChats();
  const forward = useForwardMessage();
  const [selected, setSelected] = useState<string[]>([]);

  const chats = useMemo(
    () => (allChats ?? []).filter((c) => !isChatBlocked(c, contactsById)).sort(compareChats),
    [allChats, contactsById],
  );

  const toggle = (id: string) =>
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  return (
    <div>
      <div className="scroll-thin -mx-2 max-h-72 overflow-y-auto px-2">
        {chats.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            No chats to forward to. Start a chat first.
          </p>
        ) : (
          chats.map((chat) => {
            const meta = chatMeta(chat, contactsById);
            return (
              <label
                className="hover:bg-muted flex cursor-pointer items-center gap-3 rounded-xl px-2 py-1.5 transition-colors"
                key={chat.id}
              >
                <input
                  checked={selected.includes(chat.id)}
                  className="size-4 accent-[hsl(var(--primary))]"
                  onChange={() => toggle(chat.id)}
                  type="checkbox"
                />
                <Avatar group={meta.group} hue={meta.hue} name={meta.title} size="xs" />
                <span className="text-sm">{meta.title}</span>
              </label>
            );
          })
        )}
      </div>
      <div className="mt-5 flex items-center justify-between gap-3">
        <p className="text-muted-foreground text-xs">
          {selected.length === 0 ? "Pick at least one chat." : `${selected.length} selected`}
        </p>
        <Button
          disabled={selected.length === 0 || forward.isPending}
          onClick={() => {
            if (!dialogData.messageId) {
              return closeDialog();
            }
            forward.mutate(
              { messageId: dialogData.messageId, chatIds: selected },
              {
                onSuccess: () => {
                  notify(
                    selected.length === 1
                      ? "Message forwarded"
                      : `Message forwarded to ${selected.length} chats`,
                  );
                  closeDialog();
                },
              },
            );
          }}
          variant="primary"
        >
          Forward
        </Button>
      </div>
    </div>
  );
}

export function GroupInfoForm() {
  const contactsById = useContactsById();
  const dialogData = useUi((s) => s.dialogData);
  const closeDialog = useUi((s) => s.closeDialog);
  const me = useMe();
  const { data: chats } = useChats();
  const { data: contacts = [] } = useContacts();
  const updateChat = useUpdateChat();
  const addMembers = useAddMembers();
  const removeMember = useRemoveMember();
  const chat = chats?.find((c) => c.id === dialogData.chatId);
  const [name, setName] = useState(chat?.name ?? "");
  const [adding, setAdding] = useState(false);
  const [toAdd, setToAdd] = useState<string[]>([]);

  if (chat?.type !== "group") {
    return <p className="text-muted-foreground text-sm">This group no longer exists.</p>;
  }

  const candidates = contacts
    .filter((c) => isSavedContact(c) && !chat.memberIds.includes(c.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const nameChanged = name.trim() !== "" && name.trim() !== chat.name;
  const canRemove = chat.memberIds.length > 2;

  return (
    <div className="space-y-5">
      <div>
        <label className="block text-sm font-medium" htmlFor="group-rename">
          Group name
        </label>
        <div className="mt-1.5 flex gap-2">
          <Input
            id="group-rename"
            maxLength={40}
            onChange={(e) => setName(e.target.value)}
            value={name}
          />
          <Button
            disabled={!nameChanged}
            onClick={() => updateChat.mutate({ id: chat.id, input: { name: name.trim() } })}
            variant="primary"
          >
            Save
          </Button>
        </div>
      </div>

      <section aria-label="Members">
        <div className="flex items-center justify-between pb-1">
          <h3 className="font-display text-sm font-semibold">
            {chat.memberIds.length + 1} members
          </h3>
          {candidates.length > 0 && !adding ? (
            <Button onClick={() => setAdding(true)} size="sm">
              <UserPlus className="size-4" />
              Add members
            </Button>
          ) : null}
        </div>

        {adding ? (
          <div className="border-border mb-3 rounded-xl border p-2">
            <div className="scroll-thin max-h-44 overflow-y-auto">
              {candidates.map((c) => (
                <label
                  className="hover:bg-muted flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 transition-colors"
                  key={c.id}
                >
                  <input
                    checked={toAdd.includes(c.id)}
                    className="size-4 accent-[hsl(var(--primary))]"
                    onChange={() =>
                      setToAdd((cur) =>
                        cur.includes(c.id) ? cur.filter((x) => x !== c.id) : [...cur, c.id],
                      )
                    }
                    type="checkbox"
                  />
                  <Avatar hue={c.hue} name={c.name} size="xs" />
                  <span className="text-sm">{c.name}</span>
                </label>
              ))}
            </div>
            <div className="mt-2 flex justify-end gap-2">
              <Button
                onClick={() => {
                  setAdding(false);
                  setToAdd([]);
                }}
                size="sm"
              >
                Cancel
              </Button>
              <Button
                disabled={toAdd.length === 0}
                onClick={() => {
                  addMembers.mutate({ id: chat.id, memberIds: toAdd });
                  setAdding(false);
                  setToAdd([]);
                }}
                size="sm"
                variant="primary"
              >
                Add {toAdd.length > 0 ? toAdd.length : ""}
              </Button>
            </div>
          </div>
        ) : null}

        <ul className="space-y-0.5">
          <li className="flex items-center gap-3 rounded-lg px-1 py-1.5">
            <Avatar hue={me.hue} name="You" size="xs" src={me.avatarUrl ?? undefined} />
            <span className="flex-1 text-sm">You</span>
          </li>
          {chat.memberIds.map((id) => {
            const c = contactsById.get(id);
            if (!c) {
              return null;
            }
            return (
              <li className="flex items-center gap-3 rounded-lg px-1 py-1.5" key={id}>
                <Avatar hue={c.hue} name={c.name} size="xs" />
                <span className="flex-1 text-sm">{c.name}</span>
                <Button
                  aria-label={`Remove ${c.name} from the group`}
                  disabled={!canRemove}
                  onClick={() => removeMember.mutate({ id: chat.id, contactId: id })}
                  size="icon-sm"
                  title={canRemove ? undefined : "A group needs at least two other members"}
                  variant="ghost"
                >
                  <UserMinus className="size-4" />
                </Button>
              </li>
            );
          })}
        </ul>
        {canRemove ? null : (
          <p className="text-muted-foreground mt-2 text-xs">
            A group keeps at least two other members. Add someone before removing more.
          </p>
        )}
      </section>

      <div className="flex justify-end">
        <Button onClick={closeDialog} variant="primary">
          Done
        </Button>
      </div>
    </div>
  );
}

export function EditContactForm() {
  const dialogData = useUi((s) => s.dialogData);
  const closeDialog = useUi((s) => s.closeDialog);
  const { data: contacts } = useContacts();
  const updateContact = useUpdateContact();
  const contact = contacts?.find((c) => c.id === dialogData.contactId);
  const [name, setName] = useState(contact?.name ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [about, setAbout] = useState(contact?.about ?? "");
  const [errors, setErrors] = useState<{ name?: string; phone?: string }>({});

  if (!contact) {
    return <p className="text-muted-foreground text-sm">This contact no longer exists.</p>;
  }

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
        updateContact.mutate(
          {
            id: contact.id,
            input: { name: name.trim(), phone: phone.trim(), about: about.trim() },
          },
          {
            onSuccess: () => {
              notify("Contact saved");
              closeDialog();
            },
          },
        );
      }}
    >
      <label className="block text-sm font-medium" htmlFor="edit-name">
        Name
      </label>
      <Input
        aria-describedby={errors.name ? "edit-name-error" : undefined}
        aria-invalid={!!errors.name}
        autoFocus
        className="mt-1.5"
        id="edit-name"
        onChange={(e) => setName(e.target.value)}
        value={name}
      />
      {errors.name ? (
        <p className="text-danger mt-1 text-xs" id="edit-name-error">
          {errors.name}
        </p>
      ) : null}

      <label className="mt-4 block text-sm font-medium" htmlFor="edit-phone">
        Phone number
      </label>
      <Input
        aria-describedby={errors.phone ? "edit-phone-error" : undefined}
        aria-invalid={!!errors.phone}
        className="mt-1.5"
        id="edit-phone"
        onChange={(e) => setPhone(e.target.value)}
        type="tel"
        value={phone}
      />
      {errors.phone ? (
        <p className="text-danger mt-1 text-xs" id="edit-phone-error">
          {errors.phone}
        </p>
      ) : null}

      <label className="mt-4 block text-sm font-medium" htmlFor="edit-about">
        About
      </label>
      <Input
        className="mt-1.5"
        id="edit-about"
        maxLength={80}
        onChange={(e) => setAbout(e.target.value)}
        value={about}
      />

      <div className="mt-5 flex justify-end">
        <Button type="submit" variant="primary">
          Save contact
        </Button>
      </div>
    </form>
  );
}
