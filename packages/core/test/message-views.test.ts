import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { schema, type UserRow } from "@dovetalk/db";

import { createWorld, type World } from "./support/world.js";

const { messageHidden, messageReactions, messages } = schema;

let w: World;
beforeAll(async () => {
  w = await createWorld({ storage: true });
});
afterAll(() => w.close());

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1,
]);

/** Two people with a direct chat that both can see. */
async function pair() {
  const [me, them] = [await w.user({ name: "Me Myself" }), await w.user({ name: "Una Other" })];
  const [meToThem] = await w.befriend(me, [them]);
  const [themToMe] = await w.befriend(them, [me]);
  const { chat } = await w.chats.create(me.id, { type: "direct", contactId: meToThem! });
  await w.chats.create(them.id, { type: "direct", contactId: themToMe! });
  return { me, them, meToThem: meToThem!, themToMe: themToMe!, chat };
}

const react = (messageId: string, user: UserRow, emoji: string, at: string) =>
  w.db
    .insert(messageReactions)
    .values({ messageId, userId: user.id, emoji, createdAt: new Date(at) });

const hide = (viewer: UserRow, messageId: string) =>
  w.db.insert(messageHidden).values({ userId: viewer.id, messageId });

describe("message history: reactions and files", () => {
  it("shows reactions to each viewer in their own ids, in the order they were made", async () => {
    const { me, them, meToThem, themToMe, chat } = await pair();
    const note = await w.say(chat.id, them.id, "hello");
    await react(note.id, them, "❤️", "2026-11-14T10:00:00Z");
    await react(note.id, me, "👍", "2026-11-14T10:00:05Z");

    const mine = await w.messages.page(me.id, chat.id);
    expect(mine.items[0]?.reactions).toEqual({ "❤️": [meToThem], "👍": [me.id] });
    const theirs = await w.messages.page(them.id, chat.id);
    expect(theirs.items[0]?.reactions).toEqual({ "❤️": [them.id], "👍": [themToMe] });
  });

  it("gives a message its file with a signed link, and the reply preview the file's name", async () => {
    const { me, them, chat } = await pair();
    const file = await w.uploads.create(them.id, {
      bytes: new TextEncoder().encode("hello"),
      declaredMime: "text/plain",
      name: "notes.txt",
    });
    const sent = await w.say(chat.id, them.id, "", {
      kind: "file",
      text: null,
      attachmentId: file.id,
    });
    await w.say(chat.id, me.id, "got it", { replyToId: sent.id });

    const { items } = await w.messages.page(me.id, chat.id);
    expect(items[0]?.attachment).toEqual(file);
    expect(items[1]?.replyTo).toMatchObject({ id: sent.id, kind: "file", text: "notes.txt" });
  });

  it("shows no file and no reactions on a message deleted for everyone", async () => {
    const { me, them, chat } = await pair();
    const file = await w.uploads.create(them.id, { bytes: PNG, name: "a.png" });
    const sent = await w.say(chat.id, them.id, "", { kind: "image", attachmentId: file.id });
    await react(sent.id, me, "👍", "2026-11-14T10:00:00Z");
    await w.db.update(messages).set({ deleted: true }).where(eq(messages.id, sent.id));

    const [item] = (await w.messages.page(me.id, chat.id)).items;
    expect(item).toMatchObject({ deleted: true, attachment: null, reactions: {}, text: null });
  });

  it("projects the last message of every chat with its file and reactions", async () => {
    const { me, them, meToThem, chat } = await pair();
    const file = await w.uploads.create(them.id, { bytes: PNG, name: "a.png" });
    const sent = await w.say(chat.id, them.id, "look", { kind: "image", attachmentId: file.id });
    await react(sent.id, me, "👍", "2026-11-14T10:00:00Z");

    const list = await w.chats.list(me.id);
    const view = list.find((c) => c.id === chat.id);
    expect(view?.lastMessage).toMatchObject({
      id: sent.id,
      attachment: file,
      reactions: { "👍": [me.id] },
      senderId: meToThem,
    });
  });

  it("runs the same queries for 5 messages as for 50", async () => {
    const { me, them, chat } = await pair();
    const spy = vi.spyOn(w.handle.pool, "query");
    const queriesFor = async () => {
      spy.mockClear();
      await w.messages.page(me.id, chat.id, { limit: 100 });
      return spy.mock.calls.length;
    };
    for (let i = 0; i < 5; i += 1) {
      const made = await w.say(chat.id, i % 2 ? me.id : them.id, `m${i}`);
      await react(made.id, them, "👍", "2026-11-14T10:00:00Z");
    }
    const few = await queriesFor();
    for (let i = 5; i < 50; i += 1) {
      const made = await w.say(chat.id, i % 2 ? me.id : them.id, `m${i}`);
      await react(made.id, me, "❤️", "2026-11-14T10:00:00Z");
    }
    const many = await queriesFor();
    spy.mockRestore();
    expect(few).toBeGreaterThan(0);
    expect(many).toBe(few);
  });
});

describe("delete for me", () => {
  it("leaves the message out of the viewer's pages and no one else's", async () => {
    const { me, them, chat } = await pair();
    const made: Awaited<ReturnType<World["say"]>>[] = [];
    for (let i = 1; i <= 6; i += 1) {
      made.push(await w.say(chat.id, i % 2 ? me.id : them.id, `m${i}`));
    }
    await hide(me, made[2]!.id);

    const mine = await w.messages.page(me.id, chat.id);
    expect(mine.items.map((m) => m.text)).toEqual(["m1", "m2", "m4", "m5", "m6"]);
    const theirs = await w.messages.page(them.id, chat.id);
    expect(theirs.items.map((m) => m.text)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6"]);
  });

  it("keeps paging whole when a hidden message falls on a page boundary or is the cursor", async () => {
    const { me, them, chat } = await pair();
    const made: Awaited<ReturnType<World["say"]>>[] = [];
    for (let i = 1; i <= 12; i += 1) {
      made.push(await w.say(chat.id, i % 2 ? me.id : them.id, `m${i}`));
    }
    // m8 is the oldest of a page of 5 (m8..m12 would be the first page without hiding).
    await hide(me, made[7]!.id);
    await hide(me, made[2]!.id);

    const seen: string[] = [];
    let before: string | null | undefined;
    do {
      const page = await w.messages.page(me.id, chat.id, { limit: 5, before: before ?? undefined });
      seen.unshift(...page.items.map((m) => m.text ?? ""));
      before = page.nextCursor;
    } while (before);
    expect(seen).toEqual(["m1", "m2", "m4", "m5", "m6", "m7", "m9", "m10", "m11", "m12"]);

    // A cursor that is itself a message the viewer has hidden still works.
    const page = await w.messages.page(me.id, chat.id, { before: made[7]!.id });
    expect(page.items.map((m) => m.text)).toEqual(["m1", "m2", "m4", "m5", "m6", "m7"]);
  });

  it("makes the chat's last message the newest one the viewer has not hidden", async () => {
    const { me, them, chat } = await pair();
    await w.say(chat.id, them.id, "first");
    const second = await w.say(chat.id, them.id, "second");
    const third = await w.say(chat.id, them.id, "third");
    await hide(me, third.id);

    const last = async (viewer: UserRow) =>
      (await w.chats.list(viewer.id)).find((c) => c.id === chat.id)?.lastMessage?.text;
    expect(await last(me)).toBe("second");
    expect(await last(them)).toBe("third");
    await hide(me, second.id);
    expect(await last(me)).toBe("first");
  });

  it("has no last message when everything in the chat is hidden", async () => {
    const { me, them, chat } = await pair();
    const only = await w.say(chat.id, them.id, "only");
    await hide(me, only.id);
    const view = (await w.chats.list(me.id)).find((c) => c.id === chat.id);
    expect(view?.lastMessage).toBeNull();
  });

  it("shows a reply to a message the viewer hid as a reply to a deleted one", async () => {
    const { me, them, chat } = await pair();
    const original = await w.say(chat.id, them.id, "secret");
    await w.say(chat.id, me.id, "re: secret", { replyToId: original.id });
    await hide(me, original.id);

    const { items } = await w.messages.page(me.id, chat.id);
    expect(items.map((m) => m.text)).toEqual(["re: secret"]);
    expect(items[0]?.replyTo).toMatchObject({ id: original.id, text: null, deleted: true });
    const last = (await w.chats.list(me.id)).find((c) => c.id === chat.id)?.lastMessage;
    expect(last?.replyTo).toMatchObject({ text: null, deleted: true });
    // The other person still sees the original in the preview.
    expect((await w.messages.page(them.id, chat.id)).items[1]?.replyTo?.text).toBe("secret");
  });
});
