import { afterAll, afterEach, beforeEach, describe, expect, it as test } from "vitest";

import { MESSAGE_PAGE_SIZE, PIN_LIMIT } from "@/lib/constants";

import type { Api } from "../api";
import type { ChatDto, ContactDto, MessageDto } from "../types";
import type { ConformanceArea, ConformanceHarness } from "./harness";

/**
 * One set of behaviour tests for every backend. It started as the mock server's own tests
 * (the mock is the executable spec, see docs/API.md) and now runs against the real API too.
 *
 * Rules for tests in here:
 * - Find ids through the API (a contact by name, a chat through the chat list). Never write
 *   "c1" or "chat-c1": the real API makes its own.
 * - Anything that depends on how a backend is built (how long a reply takes, how data is saved
 *   between visits) belongs in that backend's own tests, not here.
 * - Things the two backends do differently on purpose stay out of this file, and are written
 *   down in docs/API.md and docs/edge-cases.md: what deleting a contact does to groups and
 *   statuses, who may remove a group member, what adding a duplicate phone number does, the
 *   order of `chats.list()`, and how strictly `limit` is parsed. Compare phone numbers by their
 *   digits (the real API stores a display form), and after a delete check `saved !== true`
 *   rather than absence (the real API keeps the row for the people it shares chats with).
 */

/** A sign-up address nobody used before. */
const newEmail = () => `new-${Math.random().toString(36).slice(2, 10)}@example.com`;

/** The code of the error a call fails with, or null if it succeeds. */
const code = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e) => e?.code as string,
  );

/**
 * People in the seeded demo data that every new account starts with (see mock/seed.ts).
 * - `longHistory` has far more messages than one page, and unread ones.
 * - `chatty` is a direct chat that is not archived, for sending.
 */
const SEED = {
  longHistory: "Imogen Varley",
  chatty: "Priya Anand",
  other: "Tobias Kellner",
} as const;

/** Orders ids the same way on both sides of a comparison. */
const compareText = (a: string, b: string) => a.localeCompare(b);

let counter = 0;
/** Unique for the whole run, because the real API keeps client ids for good. */
const clientId = () => {
  counter += 1;
  return `conformance-${Math.random().toString(36).slice(2, 8)}-${counter}`;
};

const sendText = (api: Api, chatId: string, text: string) =>
  api.messages.send(chatId, { clientId: clientId(), kind: "text", text });

interface Direct {
  chat: ChatDto;
  contact: ContactDto;
}

async function contactNamed(api: Api, name: string): Promise<ContactDto> {
  const contact = (await api.contacts.list()).find((c) => c.name === name);
  if (!contact) {
    throw new Error(`The seed should have a contact named ${name}.`);
  }
  return contact;
}

/** The direct chat with a seeded contact, found the way the app finds it: through the list. */
async function directChatWith(api: Api, name: string): Promise<Direct> {
  const contact = await contactNamed(api, name);
  const chats = await api.chats.list();
  const chat = chats.find((c) => c.type === "direct" && c.memberIds.includes(contact.id));
  if (!chat) {
    throw new Error(`The seed should have a direct chat with ${name}.`);
  }
  return { contact, chat };
}

let phoneCounter = 0;
/** A phone number nobody else has: 11 digits, different on every call and every run. */
const randomPhone = () => {
  phoneCounter += 1;
  const tail = String(Math.floor(Math.random() * 1_000_000) + phoneCounter).padStart(7, "0");
  return `+1 555 ${tail.slice(0, 3)} ${tail.slice(3, 7)}`;
};
const digits = (phone: string) => phone.replace(/\D/gu, "");

/** A contact that has no direct chat in the seed (see mock/seed.ts). */
const NO_CHAT = "Amara Okafor";

export function runApiConformance(harness: ConformanceHarness): void {
  const area = (name: ConformanceArea, title: string, define: () => void) => {
    const enabled = harness.areas === "all" || harness.areas.has(name);
    (enabled ? describe : describe.skip)(`${harness.name}: ${title}`, define);
  };

  afterAll(() => harness.cleanup());

  area("auth", "auth", () => {
    test("logs in with the demo account and rejects wrong passwords", async () => {
      const api = harness.anonymous();
      const { email, password } = harness.demo;
      const ok = await api.auth.login({ email: ` ${email.toUpperCase()} `, password });
      expect(ok.accessToken).toBeTruthy();
      expect(ok.user.email).toBe(email);
      expect(await code(api.auth.login({ email, password: "nope" }))).toBe("INVALID_CREDENTIALS");
    });

    test("returns 401 without a token", async () => {
      const api = harness.anonymous();
      expect(await code(api.me.get())).toBe("UNAUTHORIZED");
      expect(await code(api.me.update({ name: "Nobody" }))).toBe("UNAUTHORIZED");
    });

    test("signs a new person in, and out", async () => {
      const { api } = await harness.login();
      expect((await api.me.get()).id).toBeTruthy();
      await expect(api.auth.logout()).resolves.toBeUndefined();
    });

    test("registers an account and refuses the same email twice", async () => {
      const api = harness.anonymous();
      const email = newEmail();
      const created = await api.auth.register({
        email: ` ${email.toUpperCase()} `,
        password: "correct horse",
        name: "  Sam Lee ",
      });
      expect(created.accessToken).toBeTruthy();
      expect(created.user).toMatchObject({ email, name: "Sam Lee" });

      const again = { email, password: "another password", name: "Somebody Else" };
      expect(await code(api.auth.register(again))).toBe("EMAIL_TAKEN");
      // Case and spaces make no difference to which account an address is.
      expect(await code(api.auth.register({ ...again, email: ` ${email.toUpperCase()}` }))).toBe(
        "EMAIL_TAKEN",
      );
    });

    test("says what is wrong with a sign-up", async () => {
      const api = harness.anonymous();
      const good = { email: newEmail(), password: "correct horse", name: "Sam Lee" };
      expect(await code(api.auth.register({ ...good, email: "not-an-email" }))).toBe(
        "VALIDATION_ERROR",
      );
      expect(await code(api.auth.register({ ...good, password: "short" }))).toBe(
        "VALIDATION_ERROR",
      );
      expect(await code(api.auth.register({ ...good, name: "   " }))).toBe("VALIDATION_ERROR");
      expect(
        await code(api.auth.register({ ...good, email: "guest-1@guest.dovetalk.invalid" })),
      ).toBe("VALIDATION_ERROR");
    });

    test("starts a guest, who cannot sign in again", async () => {
      const api = harness.anonymous();
      const guest = await api.auth.guest();
      expect(guest.accessToken).toBeTruthy();
      expect(guest.user.email).toMatch(/@guest\.dovetalk\.invalid$/u);
      expect(guest.user.name).toBeTruthy();

      const again = await code(
        harness.anonymous().auth.login({ email: guest.user.email, password: "guest-password" }),
      );
      expect(again).toBe("INVALID_CREDENTIALS");
    });

    test("restores a sign-in from the refresh cookie until logout", async () => {
      const api = harness.anonymous();
      expect(await code(api.auth.refresh())).toBe("UNAUTHORIZED");

      const created = await api.auth.register({
        email: newEmail(),
        password: "correct horse",
        name: "Sam Lee",
      });
      const first = await api.auth.refresh();
      expect(first.user.id).toBe(created.user.id);
      expect(first.accessToken).toBeTruthy();
      // The cookie is renewed every time, so the next refresh works too.
      expect((await api.auth.refresh()).user.id).toBe(created.user.id);

      await api.auth.logout();
      expect(await code(api.auth.refresh())).toBe("UNAUTHORIZED");
    });
  });

  area("profile", "profile", () => {
    test("updates the profile and merges preferences", async () => {
      const { api } = await harness.login();
      const me = await api.me.update({ name: "Alex R", preferences: { sounds: false } });
      expect(me.name).toBe("Alex R");
      expect(me.preferences.sounds).toBe(false);
      expect(me.preferences.previews).toBe(true);
      expect(await api.me.get()).toEqual(me);
    });

    test("changes only the fields that were sent", async () => {
      const { api } = await harness.login();
      const before = await api.me.get();
      const me = await api.me.update({ about: "  Coffee first.  " });
      expect(me.about).toBe("Coffee first.");
      expect(me.name).toBe(before.name);
      expect(me.preferences).toEqual(before.preferences);
    });

    test("rejects an empty name", async () => {
      const { api } = await harness.login();
      const before = await api.me.get();
      expect(await code(api.me.update({ name: "   " }))).toBe("VALIDATION_ERROR");
      expect((await api.me.get()).name).toBe(before.name);
    });

    test("removes the photo", async () => {
      const { api } = await harness.login();
      expect((await api.me.update({ avatarUrl: null })).avatarUrl).toBeNull();
    });
  });

  area("contacts", "contacts", () => {
    test("needs a token", async () => {
      const api = harness.anonymous();
      expect(await code(api.contacts.list())).toBe("UNAUTHORIZED");
      expect(await code(api.contacts.create({ name: "Nobody", phone: randomPhone() }))).toBe(
        "UNAUTHORIZED",
      );
    });

    test("lists the seeded contacts with every field", async () => {
      const { api } = await harness.login();
      const list = await api.contacts.list();
      expect(list.length).toBeGreaterThanOrEqual(14);
      expect(new Set(list.map((c) => c.id)).size).toBe(list.length);
      for (const c of list) {
        expect(c.id).toEqual(expect.any(String));
        expect(c.name).toEqual(expect.any(String));
        expect(c.name).not.toBe("");
        expect(c.phone).toEqual(expect.any(String));
        expect(c.about).toEqual(expect.any(String));
        expect(c.hue).toEqual(expect.any(Number));
        expect(c.online).toEqual(expect.any(Boolean));
        expect(c.blocked).toBe(false);
        expect(c.saved).toBe(true);
        expect(c.avatarUrl === null || typeof c.avatarUrl === "string").toBe(true);
      }
      const names = list.map((c) => c.name);
      expect(names).toEqual(expect.arrayContaining([SEED.longHistory, SEED.chatty, NO_CHAT]));
    });

    test("adds a contact", async () => {
      const { api } = await harness.login();
      const phone = randomPhone();
      const added = await api.contacts.create({ name: "  Zed Quill  ", phone });
      expect(added.name).toBe("Zed Quill");
      expect(digits(added.phone)).toBe(digits(phone));
      expect(added.blocked).toBe(false);
      expect(added.saved).toBe(true);
      const listed = (await api.contacts.list()).find((c) => c.id === added.id);
      expect(listed).toMatchObject({ name: "Zed Quill", blocked: false, saved: true });
    });

    test("rejects an empty name and a number with fewer than 7 digits, and adds nothing", async () => {
      const { api } = await harness.login();
      const before = (await api.contacts.list()).length;
      expect(await code(api.contacts.create({ name: "   ", phone: randomPhone() }))).toBe(
        "VALIDATION_ERROR",
      );
      expect(await code(api.contacts.create({ name: "Short", phone: "12 34 56" }))).toBe(
        "VALIDATION_ERROR",
      );
      expect((await api.contacts.list()).length).toBe(before);
    });

    test("renames a contact and sets its note", async () => {
      const { api } = await harness.login();
      const contact = await contactNamed(api, SEED.other);
      const updated = await api.contacts.update(contact.id, {
        name: "  Toby K  ",
        about: "  Out climbing.  ",
      });
      expect(updated).toMatchObject({ id: contact.id, name: "Toby K", about: "Out climbing." });
      const listed = (await api.contacts.list()).find((c) => c.id === contact.id);
      expect(listed).toMatchObject({ name: "Toby K", about: "Out climbing." });
    });

    test("rejects an empty name on update and keeps the old one", async () => {
      const { api } = await harness.login();
      const contact = await contactNamed(api, SEED.other);
      expect(await code(api.contacts.update(contact.id, { name: "  " }))).toBe("VALIDATION_ERROR");
      expect((await contactNamed(api, SEED.other)).id).toBe(contact.id);
    });

    test("blocks and unblocks", async () => {
      const { api } = await harness.login();
      const contact = await contactNamed(api, SEED.other);
      const blocked = await api.contacts.setBlocked(contact.id, true);
      expect(blocked.blocked).toBe(true);
      expect((await api.contacts.list()).find((c) => c.id === contact.id)?.blocked).toBe(true);
      const unblocked = await api.contacts.setBlocked(contact.id, false);
      expect(unblocked.blocked).toBe(false);
      expect((await api.contacts.list()).find((c) => c.id === contact.id)?.blocked).toBe(false);
    });

    test("deletes a contact and takes the direct chat out of the list", async () => {
      const { api } = await harness.login();
      const { contact, chat } = await directChatWith(api, SEED.chatty);
      await expect(api.contacts.remove(contact.id)).resolves.toBeUndefined();
      expect((await api.contacts.list()).find((c) => c.id === contact.id)?.saved).not.toBe(true);
      expect((await api.chats.list()).some((c) => c.id === chat.id)).toBe(false);
    });

    test("returns CONTACT_NOT_FOUND for a missing contact", async () => {
      const { api } = await harness.login();
      expect(await code(api.contacts.update("zzz", { name: "Nobody" }))).toBe("CONTACT_NOT_FOUND");
      expect(await code(api.contacts.remove("zzz"))).toBe("CONTACT_NOT_FOUND");
      expect(await code(api.contacts.setBlocked("zzz", true))).toBe("CONTACT_NOT_FOUND");
    });
  });

  area("paging", "paging", () => {
    test("returns pages oldest-first with a cursor that walks back to the start", async () => {
      const { api } = await harness.login();
      const { chat } = await directChatWith(api, SEED.longHistory);
      const seen: MessageDto[] = [];
      let before: string | null = null;
      let pages = 0;
      do {
        const page = await api.chats.messages(chat.id, { before, limit: MESSAGE_PAGE_SIZE });
        expect(page.items.length).toBeLessThanOrEqual(MESSAGE_PAGE_SIZE);
        for (let i = 1; i < page.items.length; i += 1) {
          expect(page.items[i].createdAt).toBeGreaterThanOrEqual(page.items[i - 1].createdAt);
        }
        seen.unshift(...page.items);
        before = page.nextCursor;
        pages += 1;
      } while (before);
      expect(pages).toBeGreaterThan(1);
      expect(new Set(seen.map((m) => m.id)).size).toBe(seen.length);
    });

    test("returns at most `limit` items, and a cursor only while older messages remain", async () => {
      const { api } = await harness.login();
      const { chat } = await directChatWith(api, SEED.longHistory);
      const small = await api.chats.messages(chat.id, { limit: 5 });
      expect(small.items).toHaveLength(5);
      expect(small.nextCursor).not.toBeNull();

      let total = 0;
      let before: string | null = null;
      do {
        const page = await api.chats.messages(chat.id, { before, limit: 100 });
        total += page.items.length;
        before = page.nextCursor;
      } while (before);
      expect(total).toBeGreaterThan(MESSAGE_PAGE_SIZE);
      expect(total).toBeLessThanOrEqual(100);

      const all = await api.chats.messages(chat.id, { limit: total });
      expect(all.items).toHaveLength(total);
      expect(all.nextCursor).toBeNull();
      const almost = await api.chats.messages(chat.id, { limit: total - 1 });
      expect(almost.items).toHaveLength(total - 1);
      expect(almost.nextCursor).not.toBeNull();
    });

    test("rejects an unknown cursor", async () => {
      const { api } = await harness.login();
      const { chat } = await directChatWith(api, SEED.longHistory);
      expect(await code(api.chats.messages(chat.id, { before: "nope" }))).toBe("INVALID_CURSOR");
    });

    test("returns CHAT_NOT_FOUND for a missing chat", async () => {
      const { api } = await harness.login();
      expect(await code(api.chats.messages("zzz"))).toBe("CHAT_NOT_FOUND");
    });
  });

  area("sending", "sending", () => {
    test("is idempotent for the same clientId", async () => {
      const { api } = await harness.login();
      const { chat } = await directChatWith(api, SEED.chatty);
      const id = clientId();
      const a = await api.messages.send(chat.id, { clientId: id, kind: "text", text: "hello" });
      const b = await api.messages.send(chat.id, { clientId: id, kind: "text", text: "hello" });
      expect(b.id).toBe(a.id);
      const page = await api.chats.messages(chat.id, { limit: 100 });
      expect(page.items.filter((m) => m.clientId === id)).toHaveLength(1);
    });

    test("trims text and rejects empty messages", async () => {
      const { api } = await harness.login();
      const { chat } = await directChatWith(api, SEED.chatty);
      const m = await sendText(api, chat.id, " hi ");
      expect(m.text).toBe("hi");
      const empty = sendText(api, chat.id, "   ");
      expect(await code(empty)).toBe("VALIDATION_ERROR");
    });

    test("updates the chat's last message", async () => {
      const { api } = await harness.login();
      const { chat } = await directChatWith(api, SEED.chatty);
      const m = await sendText(api, chat.id, "latest");
      const updated = (await api.chats.list()).find((c) => c.id === chat.id);
      expect(updated?.lastMessage?.id).toBe(m.id);
    });

    test("refuses to send to a blocked contact", async () => {
      const { api } = await harness.login();
      const { contact, chat } = await directChatWith(api, SEED.chatty);
      await api.contacts.setBlocked(contact.id, true);
      const blocked = sendText(api, chat.id, "hi");
      expect(await code(blocked)).toBe("CONTACT_BLOCKED");
      await api.contacts.setBlocked(contact.id, false);
      const again = sendText(api, chat.id, "hi");
      await expect(again).resolves.toBeDefined();
    });

    test("embeds a reply preview", async () => {
      const { api } = await harness.login();
      const { chat } = await directChatWith(api, SEED.chatty);
      const first = await api.messages.send(chat.id, {
        clientId: clientId(),
        kind: "text",
        text: "question?",
      });
      const reply = await api.messages.send(chat.id, {
        clientId: clientId(),
        kind: "text",
        text: "answer",
        replyToId: first.id,
      });
      expect(reply.replyTo).toMatchObject({ id: first.id, text: "question?", deleted: false });
    });
  });

  area("chats", "chats", () => {
    test("needs a token", async () => {
      expect(await code(harness.anonymous().chats.list())).toBe("UNAUTHORIZED");
    });

    test("enforces the pin limit", async () => {
      const { api } = await harness.login();
      const chats = await api.chats.list();
      let pinned = chats.filter((c) => c.pinned).length;
      for (const chat of chats.filter((c) => !(c.pinned || c.archived))) {
        if (pinned >= PIN_LIMIT) {
          expect(await code(api.chats.update(chat.id, { pinned: true }))).toBe("PIN_LIMIT");
          return;
        }
        await api.chats.update(chat.id, { pinned: true });
        pinned += 1;
      }
      throw new Error("The seed should have enough chats to reach the pin limit.");
    });

    test("returns the existing direct chat instead of making a second", async () => {
      const { api } = await harness.login();
      const { contact } = await directChatWith(api, SEED.longHistory);
      const a = await api.chats.create({ type: "direct", contactId: contact.id });
      const b = await api.chats.create({ type: "direct", contactId: contact.id });
      expect(b.id).toBe(a.id);
      expect((await api.chats.list()).filter((c) => c.id === a.id)).toHaveLength(1);
    });

    test("creates groups with a system note and validates members", async () => {
      const { api } = await harness.login();
      const first = await contactNamed(api, SEED.longHistory);
      const second = await contactNamed(api, SEED.other);
      const tooFew = api.chats.create({ type: "group", name: "x", memberIds: [first.id] });
      expect(await code(tooFew)).toBe("VALIDATION_ERROR");
      const chat = await api.chats.create({
        type: "group",
        name: "Trip",
        memberIds: [first.id, second.id],
      });
      expect(chat.type).toBe("group");
      const page = await api.chats.messages(chat.id);
      expect(page.items.some((m) => m.kind === "system")).toBe(true);
    });

    test("archives, mutes and pins, and puts each back", async () => {
      const { api } = await harness.login();
      const { chat } = await directChatWith(api, SEED.chatty);
      const stored = () => api.chats.list().then((l) => l.find((c) => c.id === chat.id)!);
      expect(chat).toMatchObject({ archived: false, muted: false, pinned: false });

      expect(await api.chats.update(chat.id, { archived: true })).toMatchObject({ archived: true });
      expect(await stored()).toMatchObject({ archived: true, muted: false, pinned: false });
      await api.chats.update(chat.id, { archived: false });

      expect(await api.chats.update(chat.id, { muted: true })).toMatchObject({ muted: true });
      expect(await stored()).toMatchObject({ archived: false, muted: true, pinned: false });
      await api.chats.update(chat.id, { muted: false });

      expect(await api.chats.update(chat.id, { pinned: true })).toMatchObject({ pinned: true });
      expect(await stored()).toMatchObject({ pinned: true });
      expect(await api.chats.update(chat.id, { pinned: false })).toMatchObject({ pinned: false });
      expect(await stored()).toMatchObject({ archived: false, muted: false, pinned: false });
    });

    test("renames a group with a system note, and refuses other renames", async () => {
      const { api } = await harness.login();
      const first = await contactNamed(api, SEED.longHistory);
      const second = await contactNamed(api, SEED.other);
      const group = await api.chats.create({
        type: "group",
        name: "Trip",
        memberIds: [first.id, second.id],
      });
      const renamed = await api.chats.update(group.id, { name: "  Road trip  " });
      expect(renamed.name).toBe("Road trip");
      expect((await api.chats.list()).find((c) => c.id === group.id)?.name).toBe("Road trip");
      const notes = (await api.chats.messages(group.id)).items.filter((m) => m.kind === "system");
      expect(notes.length).toBeGreaterThanOrEqual(2);
      expect(notes.at(-1)?.text).toContain("Road trip");

      expect(await code(api.chats.update(group.id, { name: "   " }))).toBe("VALIDATION_ERROR");
      expect((await api.chats.list()).find((c) => c.id === group.id)?.name).toBe("Road trip");
      const { chat: direct } = await directChatWith(api, SEED.chatty);
      expect(await code(api.chats.update(direct.id, { name: "Nope" }))).toBe("VALIDATION_ERROR");
    });

    test("adds and removes group members, and keeps at least two others", async () => {
      const { api } = await harness.login();
      const first = await contactNamed(api, SEED.longHistory);
      const second = await contactNamed(api, SEED.other);
      const third = await contactNamed(api, SEED.chatty);
      const group = await api.chats.create({
        type: "group",
        name: "Crew",
        memberIds: [first.id, second.id],
      });
      const notesIn = async () =>
        (await api.chats.messages(group.id)).items.filter((m) => m.kind === "system").length;
      const before = await notesIn();

      const added = await api.chats.addMembers(group.id, [third.id]);
      expect([...added.memberIds].sort(compareText)).toEqual(
        [first.id, second.id, third.id].sort(compareText),
      );
      expect(await notesIn()).toBe(before + 1);

      const removed = await api.chats.removeMember(group.id, third.id);
      expect([...removed.memberIds].sort(compareText)).toEqual(
        [first.id, second.id].sort(compareText),
      );
      expect(await notesIn()).toBe(before + 2);
      expect((await api.chats.list()).find((c) => c.id === group.id)?.memberIds).toHaveLength(2);

      expect(await code(api.chats.removeMember(group.id, third.id))).toBe("MEMBER_NOT_FOUND");
      expect(await code(api.chats.removeMember(group.id, first.id))).toBe("VALIDATION_ERROR");
      expect((await api.chats.list()).find((c) => c.id === group.id)?.memberIds).toHaveLength(2);
    });

    test("refuses members on a direct chat", async () => {
      const { api } = await harness.login();
      const { contact, chat } = await directChatWith(api, SEED.chatty);
      const other = await contactNamed(api, SEED.other);
      expect(await code(api.chats.addMembers(chat.id, [other.id]))).toBe("VALIDATION_ERROR");
      expect(await code(api.chats.removeMember(chat.id, contact.id))).toBe("VALIDATION_ERROR");
    });

    test("returns CHAT_NOT_FOUND for a missing chat on every chat call", async () => {
      const { api } = await harness.login();
      const { contact } = await directChatWith(api, SEED.chatty);
      expect(await code(api.chats.update("zzz", { muted: true }))).toBe("CHAT_NOT_FOUND");
      expect(await code(api.chats.remove("zzz"))).toBe("CHAT_NOT_FOUND");
      expect(await code(api.chats.markRead("zzz"))).toBe("CHAT_NOT_FOUND");
      expect(await code(api.chats.clear("zzz"))).toBe("CHAT_NOT_FOUND");
      expect(await code(api.chats.addMembers("zzz", [contact.id]))).toBe("CHAT_NOT_FOUND");
      expect(await code(api.chats.removeMember("zzz", contact.id))).toBe("CHAT_NOT_FOUND");
    });

    test("returns CONTACT_NOT_FOUND when opening a chat with a missing contact", async () => {
      const { api } = await harness.login();
      expect(await code(api.chats.create({ type: "direct", contactId: "zzz" }))).toBe(
        "CONTACT_NOT_FOUND",
      );
    });

    test("opens a direct chat with a contact that has none, empty and only once", async () => {
      const { api } = await harness.login();
      const contact = await contactNamed(api, NO_CHAT);
      const before = await api.chats.list();
      expect(before.some((c) => c.type === "direct" && c.memberIds.includes(contact.id))).toBe(
        false,
      );
      const a = await api.chats.create({ type: "direct", contactId: contact.id });
      const b = await api.chats.create({ type: "direct", contactId: contact.id });
      expect(b.id).toBe(a.id);
      expect(a).toMatchObject({ type: "direct", memberIds: [contact.id], lastMessage: null });
      const listed = (await api.chats.list()).filter((c) => c.id === a.id);
      expect(listed).toHaveLength(1);
      expect(await api.chats.messages(a.id)).toEqual({ items: [], nextCursor: null });
    });

    test("keeps a cleared chat in the list, with its flags", async () => {
      const { api } = await harness.login();
      const { chat } = await directChatWith(api, SEED.longHistory);
      await api.chats.update(chat.id, { pinned: true, muted: true });
      await api.chats.clear(chat.id);
      const cleared = (await api.chats.list()).find((c) => c.id === chat.id);
      expect(cleared).toMatchObject({ pinned: true, muted: true, unread: 0, lastMessage: null });
      expect(await api.chats.messages(chat.id)).toEqual({ items: [], nextCursor: null });
    });

    test("opens an empty chat after the old one was deleted", async () => {
      const { api } = await harness.login();
      const { contact, chat } = await directChatWith(api, SEED.longHistory);
      expect(chat.unread).toBeGreaterThan(0);
      await api.chats.remove(chat.id);
      expect((await api.chats.list()).some((c) => c.id === chat.id)).toBe(false);
      const again = await api.chats.create({ type: "direct", contactId: contact.id });
      expect(again).toMatchObject({ type: "direct", lastMessage: null, unread: 0 });
      expect(await api.chats.messages(again.id)).toEqual({ items: [], nextCursor: null });
      expect((await api.chats.list()).filter((c) => c.id === again.id)).toHaveLength(1);
    });

    test("marks read, clears, and deletes", async () => {
      const { api } = await harness.login();
      const unread = (await api.chats.list()).find((c) => c.unread > 0)!;
      await api.chats.markRead(unread.id);
      expect((await api.chats.list()).find((c) => c.id === unread.id)?.unread).toBe(0);

      await api.chats.clear(unread.id);
      const left = (await api.chats.messages(unread.id)).items.filter((m) => m.kind !== "system");
      expect(left).toHaveLength(0);

      await api.chats.remove(unread.id);
      expect(await code(api.chats.messages(unread.id))).toBe("CHAT_NOT_FOUND");
    });
  });

  area("actions", "message actions", () => {
    test("edits only my own text messages", async () => {
      const { api } = await harness.login();
      const me = await api.me.get();
      const { chat } = await directChatWith(api, SEED.chatty);
      const mine = await sendText(api, chat.id, "typo");
      const edited = await api.messages.edit(mine.id, "fixed");
      expect(edited).toMatchObject({ text: "fixed", edited: true });

      const history = await directChatWith(api, SEED.longHistory);
      const theirs = (await api.chats.messages(history.chat.id)).items.find(
        (m) => m.senderId !== me.id && m.kind === "text",
      )!;
      expect(await code(api.messages.edit(theirs.id, "nope"))).toBe("FORBIDDEN");
    });

    test("deletes for everyone as a tombstone, and for me by removing it", async () => {
      const { api } = await harness.login();
      const { chat } = await directChatWith(api, SEED.chatty);
      const a = await sendText(api, chat.id, "one");
      const b = await sendText(api, chat.id, "two");
      await api.messages.remove(a.id, "everyone");
      await api.messages.remove(b.id, "me");
      const { items } = await api.chats.messages(chat.id, { limit: 100 });
      expect(items.find((m) => m.id === a.id)).toMatchObject({ deleted: true, text: null });
      expect(items.find((m) => m.id === b.id)).toBeUndefined();
    });

    test("toggles reactions on and off", async () => {
      const { api } = await harness.login();
      const me = await api.me.get();
      const { chat } = await directChatWith(api, SEED.chatty);
      const m = await sendText(api, chat.id, "react");
      const on = await api.messages.toggleReaction(m.id, "👍");
      expect(on.reactions["👍"]).toEqual([me.id]);
      const off = await api.messages.toggleReaction(m.id, "👍");
      expect(off.reactions["👍"]).toBeUndefined();
    });

    test("forwards to several chats", async () => {
      const { api } = await harness.login();
      const { chat } = await directChatWith(api, SEED.chatty);
      const one = await directChatWith(api, SEED.longHistory);
      const two = await directChatWith(api, SEED.other);
      const m = await api.messages.send(chat.id, {
        clientId: clientId(),
        kind: "text",
        text: "pass it on",
      });
      const copies = await api.messages.forward(m.id, [one.chat.id, two.chat.id]);
      expect(copies).toHaveLength(2);
      expect(copies.every((c) => c.forwarded && c.text === "pass it on")).toBe(true);
      expect(new Set(copies.map((c) => c.chatId))).toEqual(new Set([one.chat.id, two.chat.id]));
    });
  });

  area("uploads", "uploads", () => {
    test("accepts a file and lets it be attached", async () => {
      const { api } = await harness.login();
      const { chat } = await directChatWith(api, SEED.chatty);
      const att = await api.uploads.create(new Blob(["hello"], { type: "text/plain" }), {
        name: "notes.txt",
      });
      expect(att).toMatchObject({ name: "notes.txt", size: 5, mime: "text/plain" });
      const m = await api.messages.send(chat.id, {
        clientId: clientId(),
        kind: "file",
        attachmentId: att.id,
      });
      expect(m.attachment?.id).toBe(att.id);
    });

    test("rejects oversize and empty files, and unknown attachment ids", async () => {
      const { api } = await harness.login();
      const { chat } = await directChatWith(api, SEED.chatty);
      const big = new Blob(["x".repeat(harness.uploadLimitBytes + 1)]);
      expect(await code(api.uploads.create(big, { name: "big.bin" }))).toBe("FILE_TOO_LARGE");
      expect(await code(api.uploads.create(new Blob([]), { name: "empty.bin" }))).toBe(
        "VALIDATION_ERROR",
      );
      const unknown = api.messages.send(chat.id, {
        clientId: clientId(),
        kind: "file",
        attachmentId: "nope",
      });
      expect(await code(unknown)).toBe("ATTACHMENT_NOT_FOUND");
    });
  });

  area("statuses", "statuses", () => {
    test("creates, sees, and deletes a status", async () => {
      const { api } = await harness.login();
      const s = await api.statuses.create({ text: "hi", color: 1 });
      expect((await api.statuses.list()).some((x) => x.id === s.id)).toBe(true);
      await api.statuses.remove(s.id);
      expect((await api.statuses.list()).some((x) => x.id === s.id)).toBe(false);
    });
  });

  area("realtime", "realtime", () => {
    beforeEach(() => harness.clock?.install());
    afterEach(() => harness.clock?.restore());

    test("tells me about my own message, then the chat it moved", async () => {
      const { api, realtime } = await harness.login();
      const me = await api.me.get();
      const { chat } = await directChatWith(api, SEED.chatty);
      const events: string[] = [];
      const news: MessageDto[] = [];
      const moved: ChatDto[] = [];
      const states: string[] = [];
      realtime.onConnection((s) => states.push(s));
      realtime.on("message:new", (p) => {
        events.push(`new:${p.message.id}`);
        news.push(p.message);
      });
      realtime.on("chat:updated", (p) => {
        events.push(`chat:${p.chat.id}:${p.chat.lastMessage?.id ?? ""}`);
        moved.push(p.chat);
      });
      realtime.connect();
      await harness.eventually(() => states.includes("connected"), {
        message: "The socket never connected.",
      });

      const sent = await sendText(api, chat.id, "hello there");
      await harness.eventually(() => events.includes(`chat:${chat.id}:${sent.id}`), {
        message: `The chat update never arrived. Saw: ${events.join(", ")}`,
      });

      // My own message is announced as mine, before the chat that now ends with it.
      expect(news.find((m) => m.id === sent.id)).toMatchObject({
        chatId: chat.id,
        senderId: me.id,
        text: "hello there",
      });
      expect(events.indexOf(`new:${sent.id}`)).toBeGreaterThanOrEqual(0);
      expect(events.indexOf(`new:${sent.id}`)).toBeLessThan(
        events.indexOf(`chat:${chat.id}:${sent.id}`),
      );
      expect(moved.find((c) => c.id === chat.id)?.lastMessage?.id).toBe(sent.id);
    });

    test("reports connection state", async () => {
      const { realtime } = await harness.login();
      const states: string[] = [];
      realtime.onConnection((s) => states.push(s));
      realtime.connect();
      await harness.eventually(() => states.includes("connected"), {
        message: "The socket never connected.",
      });
      expect(states).toEqual(["connecting", "connected"]);
      realtime.disconnect();
      expect(states.at(-1)).toBe("disconnected");
    });
  });

  // The mock answers on its own timers (a fake clock moves them). The real API sets a job going
  // and the worker, a separate process, answers about 3 seconds later by the real clock, so the
  // wait below is generous (15 s against a 700 ms typing job and a 2.4 s reply).
  area("bots", "bots", () => {
    beforeEach(() => harness.clock?.install());
    afterEach(() => harness.clock?.restore());

    test("emits typing and a reply after I send a message", async () => {
      const { api, realtime } = await harness.login({ botReplies: true });
      const { contact, chat } = await directChatWith(api, SEED.chatty);
      const events: string[] = [];
      const states: string[] = [];
      realtime.on("typing", (p) => events.push(`typing:${p.isTyping}`));
      realtime.on("message:new", (p) => events.push(`new:${p.message.senderId}`));
      realtime.onConnection((s) => states.push(s));
      realtime.connect();
      await harness.eventually(() => states.includes("connected"), {
        message: "The socket never connected.",
      });

      await sendText(api, chat.id, "ping");
      await harness.eventually(
        () => events.includes("typing:false") && events.includes(`new:${contact.id}`),
        { timeoutMs: 15_000, message: `No reply arrived. Saw: ${events.join(", ")}` },
      );

      expect(events).toContain("typing:true");
      expect(events.indexOf("typing:true")).toBeLessThan(events.indexOf("typing:false"));
    });
  });
}
