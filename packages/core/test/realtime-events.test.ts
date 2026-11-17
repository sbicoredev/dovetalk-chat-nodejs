import { Logger } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ChatDto, MessageDto, StatusDto } from "@dovetalk/contracts";
import { newId, schema, type UserRow } from "@dovetalk/db";

import { createWorld, type World } from "./support/world.js";

const { messages, statuses } = schema;

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

/** Two people who each have the other as a contact, and their direct chat on both lists. */
async function pair(names: [string, string] = ["Ann Pair", "Ben Pair"]) {
  const [a, b] = [await w.user({ name: names[0] }), await w.user({ name: names[1] })];
  const [aToB] = await w.befriend(a, [b]);
  const [bToA] = await w.befriend(b, [a]);
  const { chat } = await w.chats.create(a.id, { type: "direct", contactId: aToB! });
  await w.chats.create(b.id, { type: "direct", contactId: bToA! });
  await w.settle();
  return { a, b, aToB: aToB!, bToA: bToA!, chat };
}

const say = (user: UserRow, chatId: string, text = "hi") =>
  w.messages.send(user.id, chatId, { clientId: newId(), kind: "text", text });

const payloadOf = <T>(userId: string, event: string, nth = 0) =>
  w.sentTo(userId, event)[nth]?.payload as T;

const reset = async () => {
  await w.settle();
  w.sent.length = 0;
};

describe("message:new", () => {
  it("tells both people in their own terms, the sender with their clientId and the other without", async () => {
    const { a, b, aToB, bToA, chat } = await pair();
    await reset();

    const clientId = newId();
    const { message } = await w.messages.send(a.id, chat.id, {
      clientId,
      kind: "text",
      text: "hello",
    });
    await w.settle();

    const forA = payloadOf<{ message: MessageDto }>(a.id, "message:new").message;
    const forB = payloadOf<{ message: MessageDto }>(b.id, "message:new").message;
    expect(forA).toMatchObject({ id: message.id, text: "hello", senderId: a.id, clientId });
    // Ben knows Ann under his own contact id for her, and never learns her clientId.
    expect(forB).toMatchObject({ id: message.id, text: "hello", senderId: bToA, clientId: null });
    expect(forB.senderId).not.toBe(aToB);
  });

  it("follows each message with the chat as that person sees it: unread for the receiver only", async () => {
    const { a, b, bToA, aToB, chat } = await pair();
    await reset();

    const { message } = await say(a, chat.id, "ping");
    await w.settle();

    const forA = payloadOf<{ chat: ChatDto }>(a.id, "chat:updated").chat;
    const forB = payloadOf<{ chat: ChatDto }>(b.id, "chat:updated").chat;
    expect(forA).toMatchObject({ id: chat.id, unread: 0, memberIds: [aToB] });
    expect(forB).toMatchObject({ id: chat.id, unread: 1, memberIds: [bToA] });
    expect(forA.lastMessage?.id).toBe(message.id);
    expect(forB.lastMessage?.id).toBe(message.id);
  });

  it("sends the message before the chat update", async () => {
    const { a, b, chat } = await pair();
    await reset();
    await say(a, chat.id);
    await w.settle();
    expect(w.sentTo(b.id).map((s) => s.event)).toEqual(["message:new", "chat:updated"]);
  });

  it("matches what the REST API returns for the same viewer", async () => {
    const { a, b, chat } = await pair();
    await reset();
    await say(a, chat.id, "same");
    await w.settle();

    const live = payloadOf<{ message: MessageDto }>(b.id, "message:new").message;
    const stored = (await w.messages.page(b.id, chat.id)).items.at(-1);
    expect(live).toEqual(stored);
    const listed = (await w.chats.list(b.id)).find((c) => c.id === chat.id);
    expect(payloadOf<{ chat: ChatDto }>(b.id, "chat:updated").chat).toEqual(listed);
  });

  it("says nothing for a replay of a send", async () => {
    const { a, chat } = await pair();
    const clientId = newId();
    await w.messages.send(a.id, chat.id, { clientId, kind: "text", text: "once" });
    await reset();

    const again = await w.messages.send(a.id, chat.id, { clientId, kind: "text", text: "once" });
    await w.settle();
    expect(again.created).toBe(false);
    expect(w.sent).toEqual([]);
  });

  it("brings a chat the other person deleted back onto their list", async () => {
    const { a, b, chat } = await pair();
    await w.chats.remove(b.id, chat.id);
    await reset();

    await say(a, chat.id, "still there?");
    await w.settle();
    expect(w.sentTo(b.id, "message:new")).toHaveLength(1);
    expect(payloadOf<{ chat: ChatDto }>(b.id, "chat:updated").chat).toMatchObject({
      id: chat.id,
      unread: 1,
    });
  });

  it("reaches somebody who has never had the chat on their list: a first message", async () => {
    const [a, b] = [await w.user(), await w.user()];
    const [aToB] = await w.befriend(a, [b]);
    const { chat } = await w.chats.create(a.id, { type: "direct", contactId: aToB! });
    await reset();

    await say(a, chat.id, "hello stranger");
    await w.settle();
    expect(payloadOf<{ chat: ChatDto }>(b.id, "chat:updated").chat.unread).toBe(1);
    // Ben has a contact row for Ann (made with the chat), so she is not "system".
    expect(payloadOf<{ message: MessageDto }>(b.id, "message:new").message.senderId).not.toBe(
      "system",
    );
  });

  it("tells nobody but the sender when the other person has blocked them", async () => {
    const { a, b, bToA, chat } = await pair();
    await w.contacts.setBlocked(b.id, bToA, true);
    await reset();

    await say(a, chat.id, "can you hear me");
    await w.settle();
    expect(w.sentTo(b.id)).toEqual([]);
    expect(w.sentTo(a.id, "message:new")).toHaveLength(1);
  });

  it("does not tell a member about what was said before they were added", async () => {
    const [owner, one, two, late] = await w.people(4);
    const [oToOne, oToTwo, oToLate] = await w.befriend(owner!, [one!, two!, late!]);
    const group = await w.chats.create(owner!.id, {
      type: "group",
      name: "Crew",
      memberIds: [oToOne!, oToTwo!],
    });
    await w.settle();
    await say(owner!, group.chat.id, "early");
    await w.chats.addMembers(owner!.id, group.chat.id, [oToLate!]);
    await reset();

    await say(owner!, group.chat.id, "later");
    await w.settle();
    const seen = w
      .sentTo(late!.id, "message:new")
      .map((s) => (s.payload as { message: MessageDto }).message.text);
    expect(seen).toEqual(["later"]);
  });

  it("announces messages of one chat in the order they were sent, however long each one takes", async () => {
    const { a, b, chat } = await pair();
    await reset();
    // No pause between sends: the announcements pile up behind each other and must not overtake.
    for (let n = 0; n < 12; n += 1) {
      await say(a, chat.id, `m${n}`);
    }
    await w.settle();
    const told = w
      .sentTo(b.id, "message:new")
      .map((s) => (s.payload as { message: MessageDto }).message.text);
    expect(told).toEqual(Array.from({ length: 12 }, (_, n) => `m${n}`));
  });

  it("shows a reply's original to those who can see it", async () => {
    const { a, b, chat } = await pair();
    const first = await say(b, chat.id, "question?");
    await reset();

    await w.messages.send(a.id, chat.id, {
      clientId: newId(),
      kind: "text",
      text: "answer",
      replyToId: first.message.id,
    });
    await w.settle();
    const forB = payloadOf<{ message: MessageDto }>(b.id, "message:new").message;
    expect(forB.replyTo).toMatchObject({ id: first.message.id, senderId: b.id, text: "question?" });
  });
});

describe("message:updated", () => {
  it("tells both people about an edit", async () => {
    const { a, b, chat } = await pair();
    const { message } = await say(a, chat.id, "typo");
    await reset();

    await w.messages.edit(a.id, message.id, "fixed");
    await w.settle();
    for (const user of [a, b]) {
      expect(payloadOf<{ message: MessageDto }>(user.id, "message:updated").message).toMatchObject({
        id: message.id,
        text: "fixed",
        edited: true,
      });
    }
    expect(w.sent.every((s) => s.event === "message:updated")).toBe(true);
  });

  it("tells both people about a delete for everyone", async () => {
    const { a, b, chat } = await pair();
    const { message } = await say(a, chat.id);
    await reset();

    await w.messages.remove(a.id, message.id, "everyone");
    await w.settle();
    for (const user of [a, b]) {
      expect(payloadOf<{ message: MessageDto }>(user.id, "message:updated").message).toMatchObject({
        id: message.id,
        deleted: true,
        text: null,
      });
    }
  });

  it("shows a reaction under each person's own id for the reactor", async () => {
    const { a, b, bToA, chat } = await pair();
    const { message } = await say(a, chat.id);
    await reset();

    await w.messages.toggleReaction(b.id, message.id, "👍");
    await w.settle();
    expect(payloadOf<{ message: MessageDto }>(a.id, "message:updated").message.reactions).toEqual({
      "👍": [expect.not.stringMatching(a.id)],
    });
    expect(payloadOf<{ message: MessageDto }>(b.id, "message:updated").message.reactions).toEqual({
      "👍": [b.id],
    });
    expect(bToA).toBeDefined();
  });

  it("tells only the person's own devices about a delete for me, as a chat update", async () => {
    const { a, b, chat } = await pair();
    const { message } = await say(a, chat.id);
    await reset();

    await w.messages.remove(b.id, message.id, "me");
    await w.settle();
    expect(w.sentTo(a.id)).toEqual([]);
    expect(w.sentTo(b.id).map((s) => s.event)).toEqual(["chat:updated"]);
    expect(payloadOf<{ chat: ChatDto }>(b.id, "chat:updated").chat.lastMessage).toBeNull();
  });

  it("tells nobody who cannot see the message: a member who cleared the chat after it", async () => {
    const { a, b, chat } = await pair();
    const { message } = await say(a, chat.id);
    await w.chats.clear(b.id, chat.id);
    await reset();

    await w.messages.toggleReaction(a.id, message.id, "❤️");
    await w.settle();
    expect(w.sentTo(b.id)).toEqual([]);
    expect(w.sentTo(a.id, "message:updated")).toHaveLength(1);
  });

  it("tells every chat a message was forwarded into", async () => {
    const { a, b, chat } = await pair();
    const { chat: other, b: c } = await pair();
    const { message } = await say(a, chat.id, "pass it on");
    // Ann needs to be in the other chat as well to forward into it.
    const [aToC] = await w.befriend(a, [c]);
    const into = await w.chats.create(a.id, { type: "direct", contactId: aToC! });
    await reset();

    const copies = await w.messages.forward(a.id, message.id, [into.chat.id]);
    await w.settle();
    expect(copies).toHaveLength(1);
    expect(w.sentTo(a.id, "message:new")).toHaveLength(1);
    expect(w.sentTo(b.id)).toEqual([]);
    expect(other).toBeDefined();
  });
});

describe("chat events", () => {
  it("tells only the person whose flag changed", async () => {
    const { a, b, chat } = await pair();
    await reset();

    await w.chats.update(a.id, chat.id, { pinned: true, muted: true });
    await w.settle();
    expect(w.sentTo(b.id)).toEqual([]);
    expect(payloadOf<{ chat: ChatDto }>(a.id, "chat:updated").chat).toMatchObject({
      pinned: true,
      muted: true,
    });
  });

  it("tells everyone about a new group, each with their own note", async () => {
    const [owner, one, two] = await w.people(3);
    const [oToOne, oToTwo] = await w.befriend(owner!, [one!, two!]);
    await w.settle();
    w.sent.length = 0;

    const { chat } = await w.chats.create(owner!.id, {
      type: "group",
      name: "Crew",
      memberIds: [oToOne!, oToTwo!],
    });
    await w.settle();

    expect(payloadOf<{ message: MessageDto }>(owner!.id, "message:new").message.text).toBe(
      "You created this group",
    );
    const forOne = payloadOf<{ message: MessageDto }>(one!.id, "message:new").message;
    expect(forOne.kind).toBe("system");
    expect(forOne.text).toMatch(/created this group$/u);
    expect(forOne.text).not.toMatch(/^You/u);
    for (const user of [owner!, one!, two!]) {
      expect(payloadOf<{ chat: ChatDto }>(user.id, "chat:updated").chat).toMatchObject({
        id: chat.id,
        type: "group",
        name: "Crew",
      });
    }
  });

  it("tells every member about a rename, with a note, and nobody twice about the same thing", async () => {
    const [owner, one, two] = await w.people(3);
    const [oToOne, oToTwo] = await w.befriend(owner!, [one!, two!]);
    const { chat } = await w.chats.create(owner!.id, {
      type: "group",
      name: "Crew",
      memberIds: [oToOne!, oToTwo!],
    });
    await reset();

    await w.chats.update(owner!.id, chat.id, { name: "Gang" });
    await w.settle();
    for (const user of [owner!, one!, two!]) {
      expect(w.sentTo(user.id).map((s) => s.event)).toEqual(["message:new", "chat:updated"]);
      expect(payloadOf<{ chat: ChatDto }>(user.id, "chat:updated").chat.name).toBe("Gang");
    }
  });

  it("brings a group onto the lists of the people added to it, and tells the others who joined", async () => {
    const [owner, one, two, newcomer] = await w.people(4);
    const [oToOne, oToTwo, oToNew] = await w.befriend(owner!, [one!, two!, newcomer!]);
    const { chat } = await w.chats.create(owner!.id, {
      type: "group",
      name: "Crew",
      memberIds: [oToOne!, oToTwo!],
    });
    await reset();

    await w.chats.addMembers(owner!.id, chat.id, [oToNew!]);
    await w.settle();
    for (const user of [owner!, one!, two!, newcomer!]) {
      expect(w.sentTo(user.id, "chat:updated")).toHaveLength(1);
    }
    expect(payloadOf<{ chat: ChatDto }>(newcomer!.id, "chat:updated").chat).toMatchObject({
      id: chat.id,
      name: "Crew",
    });
    // The newcomer's history starts with the note that added them.
    expect(payloadOf<{ message: MessageDto }>(newcomer!.id, "message:new").message.text).toBe(
      "Person0 added you",
    );
  });

  it("takes the chat off a removed member's list and tells the rest", async () => {
    const [owner, one, two, three] = await w.people(4);
    const [oToOne, oToTwo, oToThree] = await w.befriend(owner!, [one!, two!, three!]);
    const { chat } = await w.chats.create(owner!.id, {
      type: "group",
      name: "Crew",
      memberIds: [oToOne!, oToTwo!, oToThree!],
    });
    await reset();

    await w.chats.removeMember(owner!.id, chat.id, oToThree!);
    await w.settle();
    expect(w.sentTo(three!.id).map((s) => s.event)).toEqual(["chat:removed"]);
    expect(payloadOf<{ chatId: string }>(three!.id, "chat:removed").chatId).toBe(chat.id);
    for (const user of [owner!, one!, two!]) {
      expect(w.sentTo(user.id, "message:new")).toHaveLength(1);
    }
  });

  it("tells the person's devices when they delete a chat, and nobody else", async () => {
    const { a, b, chat } = await pair();
    await reset();
    await w.chats.remove(a.id, chat.id);
    await w.settle();
    expect(w.sentTo(a.id).map((s) => s.event)).toEqual(["chat:removed"]);
    expect(w.sentTo(b.id)).toEqual([]);
  });

  it("tells the person's devices when they read a chat, but only if something was unread", async () => {
    const { a, b, chat } = await pair();
    await say(a, chat.id);
    await reset();

    await w.chats.markRead(b.id, chat.id);
    await w.settle();
    expect(payloadOf<{ chat: ChatDto }>(b.id, "chat:updated").chat.unread).toBe(0);

    w.sent.length = 0;
    await w.chats.markRead(b.id, chat.id);
    await w.settle();
    expect(w.sent).toEqual([]);
  });

  it("tells the person's devices when they clear a chat", async () => {
    const { a, b, chat } = await pair();
    await say(a, chat.id);
    await reset();
    await w.chats.clear(b.id, chat.id);
    await w.settle();
    expect(w.sentTo(a.id)).toEqual([]);
    expect(payloadOf<{ chat: ChatDto }>(b.id, "chat:updated").chat).toMatchObject({
      unread: 0,
      lastMessage: null,
    });
  });

  it("says nothing when a chat that is already open is opened again", async () => {
    const { a, aToB } = await pair();
    await reset();
    const again = await w.chats.create(a.id, { type: "direct", contactId: aToB });
    await w.settle();
    expect(again.created).toBe(false);
    expect(w.sent).toEqual([]);
  });

  it("tells the person's devices about a new chat, and a deleted one that came back", async () => {
    const [a, b] = [await w.user(), await w.user()];
    const [aToB] = await w.befriend(a, [b]);
    await w.settle();
    w.sent.length = 0;

    const { chat } = await w.chats.create(a.id, { type: "direct", contactId: aToB! });
    await w.settle();
    expect(w.sentTo(a.id, "chat:updated")).toHaveLength(1);
    expect(w.sentTo(b.id)).toEqual([]);

    await w.chats.remove(a.id, chat.id);
    await reset();
    await w.chats.create(a.id, { type: "direct", contactId: aToB! });
    await w.settle();
    expect(w.sentTo(a.id, "chat:updated")).toHaveLength(1);
  });

  it("takes the direct chat off the list when a contact is deleted", async () => {
    const { a, b, aToB, chat } = await pair();
    await reset();
    await w.contacts.remove(a.id, aToB);
    await w.settle();
    expect(w.sentTo(a.id).map((s) => s.event)).toEqual(["chat:removed"]);
    expect(payloadOf<{ chatId: string }>(a.id, "chat:removed").chatId).toBe(chat.id);
    expect(w.sentTo(b.id)).toEqual([]);
  });
});

describe("status:new", () => {
  it("reaches the author's devices as theirs and everybody who has them as a contact as a contact's", async () => {
    const [author, fan, stranger] = await w.people(3);
    const [fanToAuthor] = await w.befriend(fan!, [author!]);
    await w.settle();
    w.sent.length = 0;

    const status = await w.statuses.create(author!.id, { text: "hello world", color: 2 });
    await w.settle();

    const own = payloadOf<{ status: StatusDto }>(author!.id, "status:new").status;
    expect(own).toMatchObject({ id: status.id, ownerId: author!.id, seen: true });
    const theirs = payloadOf<{ status: StatusDto }>(fan!.id, "status:new").status;
    expect(theirs).toMatchObject({
      id: status.id,
      ownerId: fanToAuthor,
      text: "hello world",
      seen: false,
    });
    expect(w.sentTo(stranger!.id)).toEqual([]);
  });

  it("does not announce a status that was already gone", async () => {
    const [author, fan] = await w.people(2);
    await w.befriend(fan!, [author!]);
    const status = await w.statuses.create(author!.id, { text: "short lived", color: 1 });
    await w.settle();
    w.sent.length = 0;

    const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await w.db
      .update(statuses)
      .set({ createdAt: past, expiresAt: new Date(past.getTime() + 1000) })
      .where(eq(statuses.id, status.id));
    w.events.statusCreated(author!.id, status.id);
    await w.settle();
    expect(w.sent).toEqual([]);
  });
});

describe("typing", () => {
  it("tells the others in the chat, with the first name they know the typer by", async () => {
    const { a, b, bToA, chat } = await pair(["Ann Pair", "Ben Pair"]);
    await reset();

    w.events.typing(chat.id, a.id, true);
    await w.settle();
    expect(w.sentTo(a.id)).toEqual([]);
    expect(payloadOf<unknown>(b.id, "typing")).toEqual({
      chatId: chat.id,
      contactId: bToA,
      name: "Ann",
      isTyping: true,
    });

    w.events.typing(chat.id, a.id, false);
    await w.settle();
    expect((w.sentTo(b.id, "typing")[1]!.payload as { isTyping: boolean }).isTyping).toBe(false);
  });

  it("ignores somebody who is not in the chat", async () => {
    const { chat } = await pair();
    const outsider = await w.user();
    await reset();
    w.events.typing(chat.id, outsider.id, true);
    await w.settle();
    expect(w.sent).toEqual([]);
  });

  it("is not heard by somebody who blocked the typer, nor by the one the typer blocked", async () => {
    const { a, b, aToB, bToA, chat } = await pair();
    await w.contacts.setBlocked(b.id, bToA, true);
    await reset();
    w.events.typing(chat.id, a.id, true);
    await w.settle();
    expect(w.sentTo(b.id)).toEqual([]);

    await w.contacts.setBlocked(b.id, bToA, false);
    await w.contacts.setBlocked(a.id, aToB, true);
    await reset();
    w.events.typing(chat.id, a.id, true);
    await w.settle();
    expect(w.sentTo(b.id)).toEqual([]);
  });

  it("is not heard by somebody who deleted the chat from their list, or left it", async () => {
    const { a, b, chat } = await pair();
    await w.chats.remove(b.id, chat.id);
    await reset();
    w.events.typing(chat.id, a.id, true);
    await w.settle();
    expect(w.sent).toEqual([]);
  });
});

describe("presence", () => {
  it("tells everybody who has the person as a contact, under their own contact id", async () => {
    const { a, b, bToA } = await pair();
    const bystander = await w.user();
    await reset();

    w.events.presenceChanged(a.id, true);
    await w.settle();
    expect(payloadOf<unknown>(b.id, "presence")).toEqual({ contactId: bToA, online: true });
    expect(w.sentTo(bystander.id)).toEqual([]);
    // Ann has Ben as a contact, not the other way round for this event.
    expect(w.sentTo(a.id)).toEqual([]);
  });

  it("says offline to somebody who blocked the person, even when they are online", async () => {
    const { a, b, bToA } = await pair();
    await w.contacts.setBlocked(b.id, bToA, true);
    await reset();
    w.events.presenceChanged(a.id, true);
    await w.settle();
    expect(payloadOf<unknown>(b.id, "presence")).toEqual({ contactId: bToA, online: false });
  });

  it("shows a blocked pair as offline to each other at once, and as they are once unblocked", async () => {
    const { a, b, aToB, bToA } = await pair();
    await w.presence.connect(a.id, "sock-a");
    await w.presence.connect(b.id, "sock-b");
    await reset();

    await w.contacts.setBlocked(a.id, aToB, true);
    await w.settle();
    expect(payloadOf<unknown>(a.id, "presence")).toEqual({ contactId: aToB, online: false });
    expect(payloadOf<unknown>(b.id, "presence")).toEqual({ contactId: bToA, online: false });

    w.sent.length = 0;
    await w.contacts.setBlocked(a.id, aToB, false);
    await w.settle();
    expect(payloadOf<unknown>(a.id, "presence")).toEqual({ contactId: aToB, online: true });
    expect(payloadOf<unknown>(b.id, "presence")).toEqual({ contactId: bToA, online: true });
  });

  it("puts a real person's presence in the contact list, and keeps bots as they were seeded", async () => {
    const { a, b, aToB } = await pair();
    const bot = await w.bot({ botOnlineDefault: true });
    const [aToBot] = await w.befriend(a, [bot]);

    const before = await w.contacts.list(a.id);
    expect(before.find((c) => c.id === aToB)!.online).toBe(false);
    expect(before.find((c) => c.id === aToBot)!.online).toBe(true);

    await w.presence.connect(b.id, "sock-b");
    const after = await w.contacts.list(a.id);
    expect(after.find((c) => c.id === aToB)!.online).toBe(true);
  });

  it("hides presence in the list from a person who blocked you, or whom you blocked", async () => {
    const { a, b, aToB, bToA } = await pair();
    await w.presence.connect(b.id, "sock-b");
    await w.presence.connect(a.id, "sock-a");

    await w.contacts.setBlocked(b.id, bToA, true);
    // Ann did not block anyone, but Ben blocked her: she no longer sees him online.
    expect((await w.contacts.list(a.id)).find((c) => c.id === aToB)!.online).toBe(false);
    // And Ben, who blocked her, does not see her online either.
    expect((await w.contacts.list(b.id)).find((c) => c.id === bToA)!.online).toBe(false);
  });
});

describe("failures", () => {
  it("never turn a request that already succeeded into an error", async () => {
    const { a, b, chat } = await pair();
    // A publisher that blows up on every event: the send has committed, so it must still succeed.
    const publisherOf = (w.events as unknown as { publisher: { emitToUser: unknown } }).publisher;
    const original = publisherOf.emitToUser;
    // The failure is logged by design. Keep it out of the test output.
    const logged = vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    publisherOf.emitToUser = () => {
      throw new Error("Redis is down");
    };
    try {
      await expect(say(a, chat.id)).resolves.toMatchObject({ created: true });
      await w.settle();
      expect(logged).toHaveBeenCalled();
    } finally {
      publisherOf.emitToUser = original;
      logged.mockRestore();
    }
    // The message is stored. Ben finds it when he next loads the chat.
    expect((await w.messages.page(b.id, chat.id)).items.at(-1)?.text).toBe("hi");
  });

  it("are logged, and do not stop later announcements of the same chat", async () => {
    const { a, b, chat } = await pair();
    await reset();
    // An id that is not a message: the lookup finds nothing and the job ends quietly.
    w.events.messageCreated(chat.id, newId());
    await say(a, chat.id, "after the miss");
    await w.settle();
    expect(w.sentTo(b.id, "message:new")).toHaveLength(1);
    expect(await w.db.select().from(messages).where(eq(messages.chatId, chat.id))).not.toHaveLength(
      0,
    );
  });
});
