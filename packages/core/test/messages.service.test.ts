import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { MESSAGE_PAGE_MAX, MESSAGE_PAGE_SIZE, SYSTEM_SENDER } from "@dovetalk/contracts";
import { newId, schema } from "@dovetalk/db";

import { codeOf } from "./support/helpers.js";
import { createWorld, type World } from "./support/world.js";

const { messages, chats } = schema;

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

/** A direct chat between two new people, and a way to say things in it. */
async function conversation() {
  const [me, them] = [await w.user({ name: "Me Myself" }), await w.user({ name: "Una Other" })];
  const [meToThem] = await w.befriend(me, [them]);
  const [themToMe] = await w.befriend(them, [me]);
  const { chat } = await w.chats.create(me.id, { type: "direct", contactId: meToThem! });
  // Both can see it: the other person's side opens when they open it.
  await w.chats.create(them.id, { type: "direct", contactId: themToMe! });
  return { me, them, meToThem: meToThem!, themToMe: themToMe!, chat };
}

/** `n` messages alternating between the two people: "m1" is the oldest. */
async function talk(chatId: string, a: string, b: string, n: number) {
  const made: Awaited<ReturnType<World["say"]>>[] = [];
  for (let i = 1; i <= n; i += 1) {
    made.push(await w.say(chatId, i % 2 ? a : b, `m${i}`));
  }
  return made;
}

describe("MessagesService.page", () => {
  it("returns the newest page oldest first, and a cursor while there is more", async () => {
    const { me, them, chat } = await conversation();
    const made = await talk(chat.id, me.id, them.id, 60);

    const page = await w.messages.page(me.id, chat.id);

    expect(page.items).toHaveLength(MESSAGE_PAGE_SIZE);
    expect(page.items.map((m) => m.text)).toEqual(
      Array.from({ length: 25 }, (_, i) => `m${36 + i}`),
    );
    // The cursor is the oldest message on the page.
    expect(page.nextCursor).toBe(made[35]!.id);
  });

  it("walks back through the whole history with no gaps and no repeats, ending with null", async () => {
    const { me, them, chat } = await conversation();
    await talk(chat.id, me.id, them.id, 60);

    const seen: string[] = [];
    let before: string | null | undefined;
    let pages = 0;
    do {
      const page = await w.messages.page(me.id, chat.id, { before, limit: 25 });
      seen.unshift(...page.items.map((m) => m.text!));
      before = page.nextCursor;
      pages += 1;
    } while (before);

    expect(pages).toBe(3);
    expect(seen).toEqual(Array.from({ length: 60 }, (_, i) => `m${i + 1}`));
  });

  it("has no cursor when the history fits exactly, and none for an empty chat", async () => {
    const { me, them, chat } = await conversation();
    expect(await w.messages.page(me.id, chat.id)).toEqual({ items: [], nextCursor: null });
    await talk(chat.id, me.id, them.id, 10);
    const exact = await w.messages.page(me.id, chat.id, { limit: 10 });
    expect(exact.items).toHaveLength(10);
    expect(exact.nextCursor).toBeNull();
    expect((await w.messages.page(me.id, chat.id, { limit: 9 })).nextCursor).not.toBeNull();
  });

  it("clamps the page size to between 1 and the maximum", async () => {
    const { me, them, chat } = await conversation();
    await talk(chat.id, me.id, them.id, MESSAGE_PAGE_MAX + 5);
    const size = async (limit: number) =>
      (await w.messages.page(me.id, chat.id, { limit })).items.length;
    expect(await size(0)).toBe(1);
    expect(await size(-5)).toBe(1);
    expect(await size(MESSAGE_PAGE_MAX + 50)).toBe(MESSAGE_PAGE_MAX);
    expect(await size(2.9)).toBe(2);
  });

  it("treats an empty or null cursor as no cursor", async () => {
    const { me, them, chat } = await conversation();
    await talk(chat.id, me.id, them.id, 3);
    const first = await w.messages.page(me.id, chat.id);
    expect(await w.messages.page(me.id, chat.id, { before: null })).toEqual(first);
    expect(await w.messages.page(me.id, chat.id, { before: "" })).toEqual(first);
  });

  it("answers INVALID_CURSOR for a malformed id, an unknown id and a message of another chat", async () => {
    const one = await conversation();
    const two = await conversation();
    const [foreign] = await talk(two.chat.id, two.me.id, two.them.id, 1);
    await talk(one.chat.id, one.me.id, one.them.id, 2);

    const code = (before: string) =>
      codeOf(() => w.messages.page(one.me.id, one.chat.id, { before }));
    expect(await code("nope")).toBe("INVALID_CURSOR");
    expect(await code(newId())).toBe("INVALID_CURSOR");
    expect(await code(foreign!.id)).toBe("INVALID_CURSOR");
  });

  it("only returns history from where the viewer's own history starts", async () => {
    const { me, them, chat } = await conversation();
    const made = await talk(chat.id, me.id, them.id, 6);
    await w.chats.clear(me.id, chat.id);
    await w.say(chat.id, them.id, "after");

    const mine = await w.messages.page(me.id, chat.id);
    expect(mine.items.map((m) => m.text)).toEqual(["after"]);
    expect(mine.nextCursor).toBeNull();
    // A cursor into the cleared part is valid and simply finds nothing older.
    expect((await w.messages.page(me.id, chat.id, { before: made[2]!.id })).items).toEqual([]);
    // The other person's history is untouched.
    expect((await w.messages.page(them.id, chat.id, { limit: 100 })).items).toHaveLength(7);
  });

  it("is CHAT_NOT_FOUND for a chat the viewer deleted", async () => {
    const { me, chat } = await conversation();
    await w.chats.remove(me.id, chat.id);
    expect(await codeOf(() => w.messages.page(me.id, chat.id))).toBe("CHAT_NOT_FOUND");
  });
});

describe("MessagesService.page: what each viewer sees", () => {
  it("puts ids in the viewer's terms: their own user id, their contact for the other person", async () => {
    const { me, them, meToThem, themToMe, chat } = await conversation();
    await w.say(chat.id, me.id, "from me", { clientId: "client-1" });
    await w.say(chat.id, them.id, "from them", { clientId: "client-2" });

    const [mine, theirs] = (await w.messages.page(me.id, chat.id)).items;
    expect(mine).toMatchObject({ senderId: me.id, clientId: "client-1", text: "from me" });
    expect(theirs).toMatchObject({ senderId: meToThem, clientId: null, text: "from them" });

    const [flipped, own] = (await w.messages.page(them.id, chat.id)).items;
    expect(flipped).toMatchObject({ senderId: themToMe, clientId: null });
    expect(own).toMatchObject({ senderId: them.id, clientId: "client-2" });
  });

  it("reads a sender the viewer has no contact for as system, and keeps the message", async () => {
    const { me, chat } = await conversation();
    const stranger = await w.user();
    await w.say(chat.id, stranger.id, "who is this");
    const [item] = (await w.messages.page(me.id, chat.id)).items;
    expect(item).toMatchObject({ senderId: SYSTEM_SENDER, text: "who is this" });
  });

  it("renders system messages per viewer, not as stored", async () => {
    const owner = await w.user({ name: "Gail Owner" });
    const people = await w.people(2);
    const contactIds = await w.befriend(owner, people);
    const { chat } = await w.chats.create(owner.id, {
      type: "group",
      name: "G",
      memberIds: contactIds,
    });
    const ownerSees = (await w.messages.page(owner.id, chat.id)).items;
    const memberSees = (await w.messages.page(people[0]!.id, chat.id)).items;
    expect(ownerSees[0]).toMatchObject({ senderId: SYSTEM_SENDER, text: "You created this group" });
    expect(memberSees[0]).toMatchObject({
      senderId: SYSTEM_SENDER,
      text: "Gail created this group",
    });
    const [stored] = await w.db.select().from(messages).where(eq(messages.chatId, chat.id));
    expect(stored!.text).toBeNull();
  });

  it("previews the message a reply points at, and follows edits and deletes of it", async () => {
    const { me, them, meToThem, chat } = await conversation();
    const original = await w.say(chat.id, them.id, "the question");
    await w.say(chat.id, me.id, "the answer", { replyToId: original.id });

    const preview = async () => (await w.messages.page(me.id, chat.id)).items[1]!.replyTo;
    expect(await preview()).toEqual({
      id: original.id,
      senderId: meToThem,
      kind: "text",
      text: "the question",
      deleted: false,
    });
    await w.db
      .update(messages)
      .set({ text: "the edited question", edited: true })
      .where(eq(messages.id, original.id));
    expect((await preview())?.text).toBe("the edited question");
    await w.db
      .update(messages)
      .set({ text: null, deleted: true })
      .where(eq(messages.id, original.id));
    expect(await preview()).toMatchObject({ text: null, deleted: true });
  });

  it("shows a reply to a message from before the viewer's history as a deleted message", async () => {
    const { me, them, chat } = await conversation();
    const old = await w.say(chat.id, them.id, "old");
    await w.chats.clear(me.id, chat.id);
    await w.say(chat.id, me.id, "new reply", { replyToId: old.id });

    const [item] = (await w.messages.page(me.id, chat.id)).items;
    expect(item!.replyTo).toEqual({
      id: old.id,
      senderId: SYSTEM_SENDER,
      kind: "text",
      text: null,
      deleted: true,
    });
    // The person who can still see the original gets the real preview.
    const theirs = (await w.messages.page(them.id, chat.id, { limit: 100 })).items;
    expect(theirs.at(-1)!.replyTo).toMatchObject({ text: "old", deleted: false });
  });

  it("carries voice fields through", async () => {
    const { me, chat } = await conversation();
    await w.say(chat.id, me.id, "", {
      kind: "voice",
      text: null,
      duration: 12,
      bars: [10, 50, 100],
    });
    const [item] = (await w.messages.page(me.id, chat.id)).items;
    expect(item).toMatchObject({ kind: "voice", text: null, duration: 12, bars: [10, 50, 100] });
  });

  it("runs the same number of queries for a page of 5 messages and a page of 100", async () => {
    const { me, them, chat } = await conversation();
    await talk(chat.id, me.id, them.id, 100);
    const spy = vi.spyOn(w.handle.pool, "query");
    const count = async (limit: number) => {
      spy.mockClear();
      await w.messages.page(me.id, chat.id, { limit });
      return spy.mock.calls.length;
    };
    const small = await count(5);
    const large = await count(100);
    spy.mockRestore();
    expect(large).toBe(small);
  });
});

describe("MessageStore.append", () => {
  async function emptyChat() {
    const { me, chat } = await conversation();
    return { me, chatId: chat.id };
  }

  it("numbers messages 1, 2, 3 and keeps the chat's last_seq in step", async () => {
    const { me, chatId } = await emptyChat();
    const seqs: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      seqs.push((await w.say(chatId, me.id, `m${i}`)).seq);
    }
    expect(seqs).toEqual([1, 2, 3, 4]);
    const [row] = await w.db.select().from(chats).where(eq(chats.id, chatId));
    expect(row!.lastSeq).toBe(4);
  });

  it("gives simultaneous senders distinct places with no gap", async () => {
    const { me, chatId } = await emptyChat();
    const made = await Promise.all(
      Array.from({ length: 20 }, (_, i) => w.say(chatId, me.id, `p${i}`)),
    );
    expect(made.map((m) => m.seq).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    );
    // Time never runs backwards along the sequence.
    const bySeq = [...made].sort((a, b) => a.seq - b.seq);
    for (let i = 1; i < bySeq.length; i += 1) {
      expect(bySeq[i]!.createdAt.getTime()).toBeGreaterThanOrEqual(
        bySeq[i - 1]!.createdAt.getTime(),
      );
    }
  });

  it("never stamps a message earlier than the one before it", async () => {
    const { me, chatId } = await emptyChat();
    const future = new Date(Date.now() + 3_600_000);
    await w.say(chatId, me.id, "from the future", { createdAt: future });
    const next = await w.say(chatId, me.id, "now");
    expect(next.createdAt.getTime()).toBe(future.getTime());
  });

  it("uses an explicit time when given one, and writes a system event without text", async () => {
    const { me, chatId } = await emptyChat();
    const past = new Date("2020-01-01T00:00:00.000Z");
    const note = await w.db.transaction((tx) =>
      w.store.append(tx, {
        chatId,
        senderId: null,
        kind: "system",
        event: { type: "group_created", actorId: me.id },
        createdAt: past,
      }),
    );
    expect(note).toMatchObject({ senderId: null, text: null, kind: "system", createdAt: past });
  });

  it("fails for a chat that does not exist, and a rolled-back send leaves no gap", async () => {
    const { me, chatId } = await emptyChat();
    expect(await codeOf(() => w.say(newId(), me.id, "x"))).toBe("CHAT_NOT_FOUND");

    await expect(
      w.db.transaction(async (tx) => {
        await w.store.append(tx, { chatId, senderId: me.id, kind: "text", text: "doomed" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const next = await w.say(chatId, me.id, "after the failure");
    expect(next.seq).toBe(1);
  });

  it("refuses a system message that has text, before anything is written", async () => {
    const { me, chatId } = await emptyChat();
    await expect(
      w.db.transaction((tx) =>
        w.store.append(tx, {
          chatId,
          senderId: null,
          kind: "system",
          text: "typed",
          event: { type: "group_created", actorId: me.id },
        }),
      ),
    ).rejects.toThrow("never text");
    // Nothing was numbered: the next message is still the first.
    expect((await w.say(chatId, me.id, "first")).seq).toBe(1);
  });

  it("leaves it to the database to refuse a text message that carries an event", async () => {
    const { me, chatId } = await emptyChat();
    await expect(
      w.db.transaction((tx) =>
        w.store.append(tx, {
          chatId,
          senderId: me.id,
          kind: "text",
          text: "x",
          event: { type: "group_created", actorId: me.id },
        }),
      ),
    ).rejects.toThrow();
    expect((await w.say(chatId, me.id, "first")).seq).toBe(1);
  });
});
