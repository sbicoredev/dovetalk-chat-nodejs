import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type ChatDto,
  FORWARD_CHATS_MAX,
  MAX_MESSAGE_TEXT,
  type SendMessageInput,
} from "@dovetalk/contracts";
import { newId, schema, type UserRow } from "@dovetalk/db";

import { codeOf } from "./support/helpers.js";
import { createWorld, type World } from "./support/world.js";

const { chatMembers, chats, messages, messageHidden } = schema;

let w: World;
beforeAll(async () => {
  w = await createWorld({ storage: true });
});
afterAll(() => w.close());

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1,
]);
const TEXT = new TextEncoder().encode("hello");

/** Two people who both have the direct chat on their list. */
async function pair() {
  const [me, them] = [await w.user({ name: "Me Myself" }), await w.user({ name: "Una Other" })];
  const [meToThem] = await w.befriend(me, [them]);
  const [themToMe] = await w.befriend(them, [me]);
  const { chat } = await w.chats.create(me.id, { type: "direct", contactId: meToThem! });
  await w.chats.create(them.id, { type: "direct", contactId: themToMe! });
  return { me, them, meToThem: meToThem!, themToMe: themToMe!, chat };
}

const send = (user: UserRow, chatId: string, over: Partial<SendMessageInput> = {}) =>
  w.messages.send(user.id, chatId, { clientId: newId(), kind: "text", text: "hi", ...over });

const unread = async (user: UserRow, chatId: string) =>
  (
    await w.db
      .select({ n: chatMembers.unreadCount })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, user.id)))
  )[0]?.n;

const rowsIn = (chatId: string) =>
  w.db.select().from(messages).where(eq(messages.chatId, chatId)).orderBy(messages.seq);

const upload = (owner: UserRow, bytes: Uint8Array = TEXT, name = "notes.txt") =>
  w.uploads.create(owner.id, {
    bytes,
    name,
    declaredMime: bytes === TEXT ? "text/plain" : undefined,
  });

const reactCode = (user: UserRow, messageId: string, emoji: string) =>
  codeOf(() => w.messages.toggleReaction(user.id, messageId, emoji));

const stillStored = async (id: string) => (await w.attachments.rows(w.db, [id])).has(id);

describe("MessagesService.send", () => {
  it("stores a trimmed message, hands the sender their clientId and counts one unread for the other person", async () => {
    const { me, them, chat } = await pair();
    const clientId = newId();
    const { message, created } = await send(me, chat.id, { clientId, text: "  hello  " });
    expect(created).toBe(true);
    expect(message).toMatchObject({
      chatId: chat.id,
      clientId,
      senderId: me.id,
      kind: "text",
      text: "hello",
      attachment: null,
      reactions: {},
      edited: false,
      deleted: false,
      forwarded: false,
    });
    expect(await unread(them, chat.id)).toBe(1);
    expect(await unread(me, chat.id)).toBe(0);

    const seen = await w.messages.page(them.id, chat.id);
    expect(seen.items[0]).toMatchObject({ text: "hello", clientId: null });
  });

  it("is idempotent on clientId: a replay returns the first message, adds no row, no unread and no gap", async () => {
    const { me, them, chat } = await pair();
    const clientId = newId();
    const first = await send(me, chat.id, { clientId, text: "once" });
    const again = await send(me, chat.id, { clientId, text: "a different text" });
    expect(again.created).toBe(false);
    expect(again.message).toEqual(first.message);
    expect(await unread(them, chat.id)).toBe(1);

    const next = await send(me, chat.id, { text: "next" });
    const rows = await rowsIn(chat.id);
    expect(rows.filter((r) => r.kind === "text").map((r) => [r.seq, r.text])).toEqual([
      [rows[0]!.seq, "once"],
      [rows[0]!.seq + 1, "next"],
    ]);
    expect(next.created).toBe(true);
    const [row] = await w.db.select().from(chats).where(eq(chats.id, chat.id));
    expect(row?.lastSeq).toBe(rows.at(-1)!.seq);
  });

  it("serialises sends of one clientId made at the same moment: one message, one unread", async () => {
    const { me, them, chat } = await pair();
    const clientId = newId();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => send(me, chat.id, { clientId, text: "race" })),
    );
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.message.id)).size).toBe(1);
    expect((await rowsIn(chat.id)).filter((r) => r.clientId === clientId)).toHaveLength(1);
    expect(await unread(them, chat.id)).toBe(1);
  });

  it("lets two people use the same clientId, and keeps the same id apart per chat", async () => {
    const { me, them, chat } = await pair();
    const clientId = newId();
    const a = await send(me, chat.id, { clientId });
    const b = await send(them, chat.id, { clientId });
    expect([a.created, b.created]).toEqual([true, true]);
    expect(a.message.id).not.toBe(b.message.id);
  });

  it("enforces the rules of each kind", async () => {
    const { me, chat } = await pair();
    const bad = (over: Partial<SendMessageInput>) => codeOf(() => send(me, chat.id, over));
    expect(await bad({ text: "   " })).toBe("VALIDATION_ERROR");
    expect(await bad({ text: undefined })).toBe("VALIDATION_ERROR");
    expect(await bad({ text: "x".repeat(MAX_MESSAGE_TEXT + 1) })).toBe("VALIDATION_ERROR");
    expect(await bad({ clientId: "" })).toBe("VALIDATION_ERROR");
    expect(await bad({ clientId: "c".repeat(101) })).toBe("VALIDATION_ERROR");
    expect(await bad({ kind: "system" as never })).toBe("VALIDATION_ERROR");
    expect(await bad({ kind: "voice" })).toBe("VALIDATION_ERROR");
    expect(await bad({ kind: "voice", duration: 0.4 })).toBe("VALIDATION_ERROR");
    expect(await bad({ kind: "voice", duration: 90_000 })).toBe("VALIDATION_ERROR");
    expect(await bad({ kind: "voice", duration: 5, bars: [1, 2, 101] })).toBe("VALIDATION_ERROR");
    expect(await bad({ kind: "voice", duration: 5, bars: new Array(201).fill(1) })).toBe(
      "VALIDATION_ERROR",
    );

    const longest = await send(me, chat.id, { text: "x".repeat(MAX_MESSAGE_TEXT) });
    expect(longest.message.text).toHaveLength(MAX_MESSAGE_TEXT);

    const voice = await send(me, chat.id, {
      kind: "voice",
      duration: 7.6,
      bars: [0, 50, 100],
      text: "ignored",
    });
    expect(voice.message).toMatchObject({
      kind: "voice",
      duration: 8,
      bars: [0, 50, 100],
      text: null,
    });
  });

  it("answers 404 for a chat the sender cannot see, before looking at anything else", async () => {
    const { me, chat } = await pair();
    const stranger = await w.user();
    expect(await codeOf(() => send(stranger, chat.id, { text: "" }))).toBe("CHAT_NOT_FOUND");
    expect(await codeOf(() => send(me, "not-a-uuid"))).toBe("CHAT_NOT_FOUND");
    expect(await codeOf(() => send(me, newId()))).toBe("CHAT_NOT_FOUND");
  });

  it("counts unread for every other member of a group and none for the sender", async () => {
    const me = await w.user();
    const [a, b] = await w.people(2);
    const [ca, cb] = await w.befriend(me, [a!, b!]);
    const chat = await w.chats.create(me.id, {
      type: "group",
      name: "Trip",
      memberIds: [ca!, cb!],
    });
    const before = await unread(a!, chat.chat.id);
    await send(me, chat.chat.id);
    await send(b!, chat.chat.id);
    expect(await unread(a!, chat.chat.id)).toBe((before ?? 0) + 2);
    expect(await unread(b!, chat.chat.id)).toBe(1);
    expect(await unread(me, chat.chat.id)).toBe(1);
  });

  it("brings back a chat the other person deleted, with unread 1 and without what they cleared", async () => {
    const { me, them, chat } = await pair();
    await send(me, chat.id, { text: "before" });
    await w.chats.remove(them.id, chat.id);
    expect((await w.chats.list(them.id)).map((c) => c.id)).not.toContain(chat.id);

    await send(me, chat.id, { text: "after" });
    const view = (await w.chats.list(them.id)).find((c) => c.id === chat.id);
    expect(view).toMatchObject({ unread: 1, lastMessage: { text: "after" } });
    expect((await w.messages.page(them.id, chat.id)).items.map((m) => m.text)).toEqual(["after"]);
  });
});

describe("MessagesService.send: blocking", () => {
  it("refuses a send to somebody the sender blocked, until they unblock; a replay still returns", async () => {
    const { me, them, meToThem, chat } = await pair();
    const clientId = newId();
    const first = await send(me, chat.id, { clientId, text: "early" });
    await w.contacts.setBlocked(me.id, meToThem, true);
    // The block is checked before the content, as in the mock.
    expect(await codeOf(() => send(me, chat.id, { text: "" }))).toBe("CONTACT_BLOCKED");
    expect(await codeOf(() => send(me, chat.id))).toBe("CONTACT_BLOCKED");
    // The mock looks for a replay first.
    expect((await send(me, chat.id, { clientId })).message.id).toBe(first.message.id);
    // The other side can still write to me.
    expect((await send(them, chat.id)).created).toBe(true);

    await w.contacts.setBlocked(me.id, meToThem, false);
    expect((await send(me, chat.id)).created).toBe(true);
  });

  it("stores a message for the sender but never delivers it to somebody who blocked them", async () => {
    const { me, them, themToMe, chat } = await pair();
    await w.contacts.setBlocked(them.id, themToMe, true);
    await w.chats.remove(them.id, chat.id);

    const { message } = await send(me, chat.id, { text: "can you hear me" });
    expect((await w.messages.page(me.id, chat.id)).items.map((m) => m.id)).toContain(message.id);
    // No unread, no revived chat.
    expect(await unread(them, chat.id)).toBe(0);
    expect((await w.chats.list(them.id)).map((c) => c.id)).not.toContain(chat.id);
    const hidden = await w.db
      .select()
      .from(messageHidden)
      .where(eq(messageHidden.messageId, message.id));
    expect(hidden.map((h) => h.userId)).toEqual([them.id]);

    // After they unblock and reopen the chat the message is still not theirs.
    await w.contacts.setBlocked(them.id, themToMe, false);
    await w.chats.create(them.id, { type: "direct", contactId: themToMe });
    expect((await w.messages.page(them.id, chat.id)).items).toEqual([]);
    const next = await send(me, chat.id, { text: "now?" });
    expect((await w.messages.page(them.id, chat.id)).items.map((m) => m.id)).toEqual([
      next.message.id,
    ]);
  });

  it("does not block in groups", async () => {
    const me = await w.user();
    const [a, b] = await w.people(2);
    const [ca, cb] = await w.befriend(me, [a!, b!]);
    const { chat } = await w.chats.create(me.id, {
      type: "group",
      name: "G",
      memberIds: [ca!, cb!],
    });
    await w.contacts.setBlocked(me.id, ca!, true);
    expect((await send(me, chat.id)).created).toBe(true);
  });
});

describe("MessagesService.send: attachments", () => {
  it("sends a file with its caption and consumes the upload", async () => {
    const { me, chat } = await pair();
    const file = await upload(me);
    const { message } = await send(me, chat.id, {
      kind: "file",
      attachmentId: file.id,
      text: "  the notes  ",
    });
    expect(message).toMatchObject({ kind: "file", text: "the notes" });
    expect(message.attachment).toEqual(file);
    expect(await codeOf(() => send(me, chat.id, { kind: "file", attachmentId: file.id }))).toBe(
      "ATTACHMENT_NOT_FOUND",
    );
  });

  it("gives no caption instead of an error when the caption is empty, and cuts a long one", async () => {
    const { me, chat } = await pair();
    const a = await send(me, chat.id, {
      kind: "image",
      attachmentId: (await upload(me, PNG, "a.png")).id,
      text: "   ",
    });
    expect(a.message.text).toBeNull();
    const b = await send(me, chat.id, {
      kind: "image",
      attachmentId: (await upload(me, PNG, "b.png")).id,
      text: "y".repeat(MAX_MESSAGE_TEXT + 50),
    });
    expect(b.message.text).toHaveLength(MAX_MESSAGE_TEXT);
  });

  it("refuses a missing, malformed, foreign or non-image attachment", async () => {
    const { me, them, chat } = await pair();
    const theirs = await upload(them);
    const notPicture = await upload(me);
    const go = (kind: "image" | "file", attachmentId?: string) =>
      codeOf(() => send(me, chat.id, { kind, attachmentId }));
    expect(await go("file")).toBe("ATTACHMENT_NOT_FOUND");
    expect(await go("file", "nope")).toBe("ATTACHMENT_NOT_FOUND");
    expect(await go("file", newId())).toBe("ATTACHMENT_NOT_FOUND");
    expect(await go("file", theirs.id)).toBe("ATTACHMENT_NOT_FOUND");
    expect(await go("image", notPicture.id)).toBe("VALIDATION_ERROR");
    // A refusal does not use the upload up.
    expect((await send(me, chat.id, { kind: "file", attachmentId: notPicture.id })).created).toBe(
      true,
    );
  });

  it("lets only one of two sends at once take an upload", async () => {
    const { me, chat } = await pair();
    const file = await upload(me);
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => send(me, chat.id, { kind: "file", attachmentId: file.id })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status === "rejected")
        .every((r) => (r as PromiseRejectedResult).reason.code === "ATTACHMENT_NOT_FOUND"),
    ).toBe(true);
  });

  it("leaves the upload free when the send fails afterwards", async () => {
    const { me, chat } = await pair();
    const file = await upload(me);
    expect(
      await codeOf(() =>
        send(me, chat.id, { kind: "file", attachmentId: file.id, replyToId: newId() }),
      ),
    ).toBe("VALIDATION_ERROR");
    expect((await send(me, chat.id, { kind: "file", attachmentId: file.id })).created).toBe(true);
  });

  it("will not take a file a profile photo already uses", async () => {
    const { me, chat } = await pair();
    const photo = await upload(me, PNG, "me.png");
    await w.db
      .update(schema.users)
      .set({ avatarAttachmentId: photo.id })
      .where(eq(schema.users.id, me.id));
    expect(await codeOf(() => send(me, chat.id, { kind: "image", attachmentId: photo.id }))).toBe(
      "ATTACHMENT_NOT_FOUND",
    );
  });
});

describe("MessagesService.send: replies", () => {
  it("embeds a preview of the original, which follows its later edit", async () => {
    const { me, them, chat } = await pair();
    const original = await send(them, chat.id, { text: "lunch?" });
    const reply = await send(me, chat.id, { text: "yes", replyToId: original.message.id });
    expect(reply.message.replyTo).toMatchObject({
      id: original.message.id,
      text: "lunch?",
      deleted: false,
    });
    await w.messages.edit(them.id, original.message.id, "dinner?");
    const { items } = await w.messages.page(me.id, chat.id);
    expect(items[1]?.replyTo?.text).toBe("dinner?");
  });

  it("refuses an original from another chat, one the sender hid or cleared, and an unknown one", async () => {
    const { me, them, chat } = await pair();
    const other = await pair();
    const foreign = await send(other.me, other.chat.id);
    const hidden = await send(them, chat.id, { text: "hidden" });
    await w.messages.remove(me.id, hidden.message.id, "me");
    const old = await send(them, chat.id, { text: "old" });
    const go = (replyToId: string) => codeOf(() => send(me, chat.id, { replyToId }));
    expect(await go(foreign.message.id)).toBe("VALIDATION_ERROR");
    expect(await go(hidden.message.id)).toBe("VALIDATION_ERROR");
    expect(await go(newId())).toBe("VALIDATION_ERROR");
    expect(await go("nope")).toBe("VALIDATION_ERROR");
    await w.chats.clear(me.id, chat.id);
    expect(await go(old.message.id)).toBe("VALIDATION_ERROR");
  });

  it("allows a reply to a message that was deleted for everyone", async () => {
    const { me, them, chat } = await pair();
    const original = await send(them, chat.id, { text: "oops" });
    await w.messages.remove(them.id, original.message.id, "everyone");
    const reply = await send(me, chat.id, { replyToId: original.message.id });
    expect(reply.message.replyTo).toMatchObject({ text: null, deleted: true });
  });
});

describe("MessagesService.edit", () => {
  it("changes your own text, marks it edited, and shows it to the other person", async () => {
    const { me, them, chat } = await pair();
    const { message } = await send(me, chat.id, { text: "typo" });
    const edited = await w.messages.edit(me.id, message.id, "  fixed  ");
    expect(edited).toMatchObject({ id: message.id, text: "fixed", edited: true, senderId: me.id });
    expect((await w.messages.page(them.id, chat.id)).items[0]).toMatchObject({
      text: "fixed",
      edited: true,
    });
  });

  it("checks in order: 404, then 403, then 422", async () => {
    const { me, them, chat } = await pair();
    const mine = await send(me, chat.id);
    const theirs = await send(them, chat.id);
    const stranger = await w.user();
    // Not yours is 403 before the text is looked at.
    expect(await codeOf(() => w.messages.edit(me.id, theirs.message.id, ""))).toBe("FORBIDDEN");
    expect(await codeOf(() => w.messages.edit(stranger.id, mine.message.id, "x"))).toBe(
      "MESSAGE_NOT_FOUND",
    );
    expect(await codeOf(() => w.messages.edit(me.id, "nope", "x"))).toBe("MESSAGE_NOT_FOUND");
    expect(await codeOf(() => w.messages.edit(me.id, mine.message.id, "   "))).toBe(
      "VALIDATION_ERROR",
    );
    expect(await codeOf(() => w.messages.edit(me.id, mine.message.id, "x".repeat(4001)))).toBe(
      "VALIDATION_ERROR",
    );
    // The failed attempts changed nothing.
    expect((await w.messages.page(me.id, chat.id)).items[0]).toMatchObject({
      edited: false,
      text: "hi",
    });
  });

  it("cannot edit a system message, a voice message or a deleted one", async () => {
    const me = await w.user();
    const [a, b] = await w.people(2);
    const [ca, cb] = await w.befriend(me, [a!, b!]);
    const { chat } = await w.chats.create(me.id, {
      type: "group",
      name: "G",
      memberIds: [ca!, cb!],
    });
    const [note] = (await w.messages.page(me.id, chat.id)).items;
    expect(note?.senderId).toBe("system");
    expect(await codeOf(() => w.messages.edit(me.id, note!.id, "x"))).toBe("FORBIDDEN");

    const voice = await send(me, chat.id, { kind: "voice", duration: 3 });
    expect(await codeOf(() => w.messages.edit(me.id, voice.message.id, "x"))).toBe(
      "VALIDATION_ERROR",
    );
    const text = await send(me, chat.id);
    await w.messages.remove(me.id, text.message.id, "everyone");
    expect(await codeOf(() => w.messages.edit(me.id, text.message.id, "x"))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("edits a caption, and lets it become empty", async () => {
    const { me, chat } = await pair();
    const file = await upload(me);
    const { message } = await send(me, chat.id, {
      kind: "file",
      attachmentId: file.id,
      text: "old",
    });
    expect((await w.messages.edit(me.id, message.id, " new ")).text).toBe("new");
    expect((await w.messages.edit(me.id, message.id, "  ")).text).toBeNull();
  });
});

describe("MessagesService.remove", () => {
  it("deletes for me only: the other person keeps it, and it is the viewer's alone", async () => {
    const { me, them, chat } = await pair();
    const { message } = await send(them, chat.id, { text: "keep" });
    await w.messages.remove(me.id, message.id, "me");
    await w.messages.remove(me.id, newId(), "me").catch(() => undefined);
    expect((await w.messages.page(me.id, chat.id)).items).toEqual([]);
    expect((await w.messages.page(them.id, chat.id)).items).toHaveLength(1);
    // Gone for me, so a second delete is a 404.
    expect(await codeOf(() => w.messages.remove(me.id, message.id, "me"))).toBe(
      "MESSAGE_NOT_FOUND",
    );
  });

  it("deletes for everyone: sender only, leaving a tombstone without text, file or reactions", async () => {
    const { me, them, chat } = await pair();
    const file = await upload(me);
    const { message } = await send(me, chat.id, {
      kind: "file",
      attachmentId: file.id,
      text: "cap",
    });
    await w.messages.toggleReaction(them.id, message.id, "👍");

    expect(await codeOf(() => w.messages.remove(them.id, message.id, "everyone"))).toBe(
      "FORBIDDEN",
    );
    await w.messages.remove(me.id, message.id, "everyone");
    // Doing it twice is fine.
    await w.messages.remove(me.id, message.id, "everyone");

    for (const viewer of [me, them]) {
      const [item] = (await w.messages.page(viewer.id, chat.id)).items;
      expect(item).toMatchObject({
        deleted: true,
        text: null,
        attachment: null,
        reactions: {},
        forwarded: false,
        edited: false,
      });
    }
    expect(await stillStored(file.id)).toBe(false);
  });

  it("refuses a missing or unknown scope instead of picking the destructive one", async () => {
    const { me, chat } = await pair();
    const { message } = await send(me, chat.id);
    expect(await codeOf(() => w.messages.remove(me.id, message.id, undefined as never))).toBe(
      "VALIDATION_ERROR",
    );
    expect(await codeOf(() => w.messages.remove(me.id, message.id, "all" as never))).toBe(
      "VALIDATION_ERROR",
    );
    expect((await w.messages.page(me.id, chat.id)).items[0]?.deleted).toBe(false);
  });

  it("answers 404 for somebody else's message, never 403", async () => {
    const { me, chat } = await pair();
    const { message } = await send(me, chat.id);
    const stranger = await w.user();
    expect(await codeOf(() => w.messages.remove(stranger.id, message.id, "everyone"))).toBe(
      "MESSAGE_NOT_FOUND",
    );
    expect(await codeOf(() => w.messages.remove(stranger.id, message.id, "me"))).toBe(
      "MESSAGE_NOT_FOUND",
    );
  });

  it("keeps a file a forwarded copy still uses, and removes it with the last message that uses it", async () => {
    const { me, them, chat } = await pair();
    const file = await upload(me);
    const { message } = await send(me, chat.id, { kind: "file", attachmentId: file.id });
    const [copy] = await w.messages.forward(me.id, message.id, [chat.id]);
    expect(copy?.attachment?.id).toBe(file.id);

    await w.messages.remove(me.id, message.id, "everyone");
    expect(await stillStored(file.id)).toBe(true);
    expect((await w.messages.page(them.id, chat.id)).items.at(-1)?.attachment?.id).toBe(file.id);

    await w.messages.remove(me.id, copy!.id, "everyone");
    expect(await stillStored(file.id)).toBe(false);
  });
});

describe("MessagesService.toggleReaction", () => {
  it("adds, takes back and replaces: one reaction per person", async () => {
    const { me, them, meToThem, chat } = await pair();
    const { message } = await send(them, chat.id);

    const on = await w.messages.toggleReaction(me.id, message.id, "👍");
    expect(on.reactions).toEqual({ "👍": [me.id] });
    const replaced = await w.messages.toggleReaction(me.id, message.id, "❤️");
    expect(replaced.reactions).toEqual({ "❤️": [me.id] });
    await w.messages.toggleReaction(them.id, message.id, "❤️");
    expect((await w.messages.page(me.id, chat.id)).items[0]?.reactions).toEqual({
      "❤️": [me.id, meToThem],
    });
    const off = await w.messages.toggleReaction(me.id, message.id, "❤️");
    expect(off.reactions).toEqual({ "❤️": [meToThem] });
  });

  it("accepts flags, skin tones, joined emoji and keycaps, and refuses everything else", async () => {
    const { me, chat } = await pair();
    const { message } = await send(me, chat.id);
    for (const emoji of ["🇧🇩", "👍🏽", "👨‍👩‍👧‍👦", "1️⃣", "❤️"]) {
      expect((await w.messages.toggleReaction(me.id, message.id, emoji)).reactions).toEqual({
        [emoji]: [me.id],
      });
    }
    for (const emoji of ["", "a", "1", "👍 ", "hi👍", "x".repeat(33), "👍".repeat(17)]) {
      expect(await reactCode(me, message.id, emoji), JSON.stringify(emoji)).toBe(
        "VALIDATION_ERROR",
      );
    }
    expect(await codeOf(() => w.messages.toggleReaction(me.id, message.id, 5 as never))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("cannot react to a deleted or system message", async () => {
    const me = await w.user();
    const [a, b] = await w.people(2);
    const [ca, cb] = await w.befriend(me, [a!, b!]);
    const { chat } = await w.chats.create(me.id, {
      type: "group",
      name: "G",
      memberIds: [ca!, cb!],
    });
    const [note] = (await w.messages.page(me.id, chat.id)).items;
    expect(await codeOf(() => w.messages.toggleReaction(me.id, note!.id, "👍"))).toBe(
      "VALIDATION_ERROR",
    );
    const { message } = await send(me, chat.id);
    await w.messages.remove(me.id, message.id, "everyone");
    expect(await codeOf(() => w.messages.toggleReaction(me.id, message.id, "👍"))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("answers 404 for a message the person cannot see", async () => {
    const { me, chat } = await pair();
    const { message } = await send(me, chat.id);
    const stranger = await w.user();
    expect(await codeOf(() => w.messages.toggleReaction(stranger.id, message.id, "👍"))).toBe(
      "MESSAGE_NOT_FOUND",
    );
  });

  it("holds up when many people react at once", async () => {
    const me = await w.user();
    const crowd = await w.people(6);
    const contactIds = await w.befriend(me, crowd);
    const { chat } = await w.chats.create(me.id, {
      type: "group",
      name: "Crowd",
      memberIds: contactIds,
    });
    const { message } = await send(me, chat.id);
    await Promise.all(
      crowd.flatMap((p, i) => [
        w.messages.toggleReaction(p.id, message.id, i % 2 ? "👍" : "❤️"),
        w.messages.toggleReaction(me.id, message.id, "🔥"),
      ]),
    );
    const { reactions } = (await w.messages.page(me.id, chat.id)).items.at(-1)!;
    expect(Object.values(reactions).flat()).toHaveLength(
      new Set(Object.values(reactions).flat()).size,
    );
    expect(reactions["👍"]).toHaveLength(3);
    expect(reactions["❤️"]).toHaveLength(3);
  });
});

describe("MessagesService.forward", () => {
  async function chatsFor(me: UserRow, count: number) {
    const people = await w.people(count);
    const contactIds = await w.befriend(me, people);
    const out: { chat: ChatDto; person: UserRow }[] = [];
    for (const [i, contactId] of contactIds.entries()) {
      const { chat } = await w.chats.create(me.id, { type: "direct", contactId });
      out.push({ chat, person: people[i]! });
    }
    return out;
  }

  it("copies the text into each chat, in the order of chatIds, as the viewer's own and forwarded", async () => {
    const me = await w.user();
    const [a, b, c] = await chatsFor(me, 3);
    const source = await send(me, a!.chat.id, { text: "pass it on", replyToId: undefined });
    const copies = await w.messages.forward(me.id, source.message.id, [c!.chat.id, b!.chat.id]);
    expect(copies.map((m) => m.chatId)).toEqual([c!.chat.id, b!.chat.id]);
    for (const copy of copies) {
      expect(copy).toMatchObject({
        text: "pass it on",
        forwarded: true,
        senderId: me.id,
        clientId: null,
        replyTo: null,
        reactions: {},
        edited: false,
      });
      expect(copy.id).not.toBe(source.message.id);
    }
    expect(await unread(c!.person, c!.chat.id)).toBe(1);
    expect((await w.messages.page(me.id, b!.chat.id)).items.at(-1)?.forwarded).toBe(true);
  });

  it("copies a voice message's length and waveform, and shares a picture's file", async () => {
    const me = await w.user();
    const [a, b] = await chatsFor(me, 2);
    const voice = await send(me, a!.chat.id, { kind: "voice", duration: 12, bars: [5, 50, 95] });
    const [v] = await w.messages.forward(me.id, voice.message.id, [b!.chat.id]);
    expect(v).toMatchObject({ kind: "voice", duration: 12, bars: [5, 50, 95] });

    const file = await upload(me, PNG, "p.png");
    const pic = await send(me, a!.chat.id, { kind: "image", attachmentId: file.id, text: "cap" });
    const [p] = await w.messages.forward(me.id, pic.message.id, [b!.chat.id]);
    expect(p).toMatchObject({ kind: "image", text: "cap" });
    expect(p?.attachment?.id).toBe(file.id);
  });

  it("skips a direct chat the viewer blocked, so the result can be shorter", async () => {
    const me = await w.user();
    const [a, b, c] = await chatsFor(me, 3);
    const source = await send(me, a!.chat.id);
    const blockedContact = (await w.contacts.list(me.id)).find((x) => x.name === b!.person.name)!;
    await w.contacts.setBlocked(me.id, blockedContact.id, true);
    const copies = await w.messages.forward(me.id, source.message.id, [b!.chat.id, c!.chat.id]);
    expect(copies.map((m) => m.chatId)).toEqual([c!.chat.id]);
    expect(await rowsIn(b!.chat.id)).toHaveLength(0);
  });

  it("stores, but does not deliver, a copy for somebody who blocked the viewer", async () => {
    const me = await w.user();
    const [a, b] = await chatsFor(me, 2);
    await w.contacts.ensureContact(w.db, b!.person.id, me.id);
    const theirContact = (await w.contacts.list(b!.person.id)).find((x) => x.name === me.name)!;
    await w.contacts.setBlocked(b!.person.id, theirContact.id, true);
    const source = await send(me, a!.chat.id);
    const [copy] = await w.messages.forward(me.id, source.message.id, [b!.chat.id]);
    expect(copy).toBeDefined();
    expect(await unread(b!.person, b!.chat.id)).toBe(0);
  });

  it("is all or nothing: a chat the viewer cannot see is a 404 and nothing is written", async () => {
    const me = await w.user();
    const [a, b] = await chatsFor(me, 2);
    const other = await pair();
    const source = await send(me, a!.chat.id);
    expect(
      await codeOf(() => w.messages.forward(me.id, source.message.id, [b!.chat.id, other.chat.id])),
    ).toBe("CHAT_NOT_FOUND");
    expect(
      await codeOf(() => w.messages.forward(me.id, source.message.id, [b!.chat.id, "nope"])),
    ).toBe("CHAT_NOT_FOUND");
    expect(await rowsIn(b!.chat.id)).toHaveLength(0);
    expect(await rowsIn(other.chat.id)).toHaveLength(0);
  });

  it("de-duplicates chats, caps the number, and refuses messages it cannot copy", async () => {
    const me = await w.user();
    const [a, b] = await chatsFor(me, 2);
    const source = await send(me, a!.chat.id);
    const twice = await w.messages.forward(me.id, source.message.id, [b!.chat.id, b!.chat.id]);
    expect(twice).toHaveLength(1);
    expect(await w.messages.forward(me.id, source.message.id, [])).toEqual([]);

    const many = Array.from({ length: FORWARD_CHATS_MAX + 1 }, () => newId());
    expect(await codeOf(() => w.messages.forward(me.id, source.message.id, many))).toBe(
      "VALIDATION_ERROR",
    );
    expect(await codeOf(() => w.messages.forward(me.id, source.message.id, "x" as never))).toBe(
      "VALIDATION_ERROR",
    );

    await w.messages.remove(me.id, source.message.id, "everyone");
    expect(await codeOf(() => w.messages.forward(me.id, source.message.id, [b!.chat.id]))).toBe(
      "VALIDATION_ERROR",
    );
    const group = await w.chats.create(me.id, {
      type: "group",
      name: "G",
      memberIds: (await w.contacts.list(me.id)).slice(0, 2).map((c) => c.id),
    });
    const [note] = (await w.messages.page(me.id, group.chat.id)).items;
    expect(await codeOf(() => w.messages.forward(me.id, note!.id, [b!.chat.id]))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("is 404 for a message the viewer cannot see, and lets two forwards into the same chats run together", async () => {
    const me = await w.user();
    const [a, b, c] = await chatsFor(me, 3);
    const stranger = await w.user();
    const source = await send(me, a!.chat.id);
    expect(
      await codeOf(() => w.messages.forward(stranger.id, source.message.id, [a!.chat.id])),
    ).toBe("MESSAGE_NOT_FOUND");

    const results = await Promise.all([
      w.messages.forward(me.id, source.message.id, [b!.chat.id, c!.chat.id]),
      w.messages.forward(me.id, source.message.id, [c!.chat.id, b!.chat.id]),
    ]);
    expect(results.map((r) => r.length)).toEqual([2, 2]);
    expect(await rowsIn(b!.chat.id)).toHaveLength(2);
    expect(await rowsIn(c!.chat.id)).toHaveLength(2);
  });
});
