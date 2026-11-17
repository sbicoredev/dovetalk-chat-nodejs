import { and, eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type ChatDto,
  MESSAGE_PAGE_MAX,
  MESSAGE_PAGE_SIZE,
  type MessageDto,
  type MessagePage,
} from "@dovetalk/contracts";
import { schema } from "@dovetalk/db";

import { createTestApp, type TestAccount, type TestApp } from "./support/create-test-app.js";

const { chatMembers, contacts, messages } = schema;

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const page = (a: TestAccount, chatId: string, query = "") =>
  request(t.server).get(`/chats/${chatId}/messages${query}`).set(a.bearer);

/**
 * The account's chats, found through the database, so these tests need nothing but the
 * messages endpoint. Direct chats are keyed by the other person's name.
 */
async function setup() {
  const a = await t.signUp();
  const rows = await t.db
    .select({ chatId: chatMembers.chatId })
    .from(chatMembers)
    .where(eq(chatMembers.userId, a.user.id));
  const chatIds = rows.map((r) => r.chatId);
  // The chat with the most messages is the seeded conversation with the first contact.
  const counts = await Promise.all(
    chatIds.map(async (chatId) => ({
      chatId,
      n: (await t.db.select({ id: messages.id }).from(messages).where(eq(messages.chatId, chatId)))
        .length,
    })),
  );
  return { a, chatIds, counts };
}

async function walk(a: TestAccount, chatId: string, limit: number) {
  const pages: MessagePage[] = [];
  let before: string | null = null;
  do {
    const query = `?limit=${limit}${before ? `&before=${before}` : ""}`;
    const body = (await page(a, chatId, query).expect(200)).body as MessagePage;
    pages.push(body);
    before = body.nextCursor;
  } while (before && pages.length < 100);
  return pages;
}

describe("GET /chats/:id/messages", () => {
  it("needs a signed-in person", async () => {
    await request(t.server).get("/chats/anything/messages").expect(401);
  });

  it("returns the newest page, oldest first, with the default size", async () => {
    const { a, counts } = await setup();
    const big = counts.find((c) => c.n === 77)!;
    const res = await page(a, big.chatId).expect(200);
    expect(res.body.items).toHaveLength(MESSAGE_PAGE_SIZE);
    expect(res.body.nextCursor).toBe(res.body.items[0].id);
    const times = res.body.items.map((m: MessageDto) => m.createdAt);
    expect(times).toEqual([...times].sort((x, y) => x - y));
    expect(res.body.items[0]).toEqual({
      id: expect.any(String),
      chatId: big.chatId,
      clientId: null,
      senderId: expect.any(String),
      kind: expect.stringMatching(/^(text|voice|system)$/u),
      text: expect.toSatisfy((x) => x === null || typeof x === "string"),
      duration: null,
      bars: null,
      attachment: null,
      createdAt: expect.any(Number),
      replyTo: null,
      reactions: {},
      edited: false,
      deleted: false,
      forwarded: false,
    });
  });

  it("walks back to the start, once each, with no gap and no overlap", async () => {
    const { a, counts } = await setup();
    const big = counts.find((c) => c.n === 77)!;
    for (const limit of [25, 10, 7, 1]) {
      const pages = await walk(a, big.chatId, limit);
      const ids = pages.flatMap((p) => p.items).map((m) => m.id);
      expect(ids).toHaveLength(77);
      expect(new Set(ids).size).toBe(77);
      expect(pages.at(-1)!.nextCursor).toBeNull();
      expect(pages.slice(0, -1).every((p) => p.nextCursor !== null)).toBe(true);
      // Oldest page first when the pages are put back in order, and in time order throughout.
      const chronological = [...pages].reverse().flatMap((p) => p.items);
      const times = chronological.map((m) => m.createdAt);
      expect(times).toEqual([...times].sort((x, y) => x - y));
      expect(pages.map((p) => p.items.length).reduce((x, y) => x + y)).toBe(77);
    }
  });

  it("has no next page when the last page is exactly full", async () => {
    const { a, counts } = await setup();
    const small = counts.find((c) => c.n === 3)!;
    const exact = await page(a, small.chatId, "?limit=3").expect(200);
    expect(exact.body.items).toHaveLength(3);
    expect(exact.body.nextCursor).toBeNull();
    const short = await page(a, small.chatId, "?limit=2").expect(200);
    expect(short.body.nextCursor).toBe(short.body.items[0].id);
    const rest = await page(a, small.chatId, `?limit=2&before=${short.body.nextCursor}`).expect(
      200,
    );
    expect(rest.body.items).toHaveLength(1);
    expect(rest.body.nextCursor).toBeNull();
  });

  it("brings the limit inside 1 to 100 and refuses what is not a number", async () => {
    const { a, counts } = await setup();
    const big = counts.find((c) => c.n === 77)!;
    expect(MESSAGE_PAGE_MAX).toBe(100);
    expect((await page(a, big.chatId, "?limit=500").expect(200)).body.items).toHaveLength(77);
    expect((await page(a, big.chatId, "?limit=0").expect(200)).body.items).toHaveLength(1);
    expect((await page(a, big.chatId, "?limit=-5").expect(200)).body.items).toHaveLength(1);
    expect((await page(a, big.chatId, "?limit=").expect(200)).body.items).toHaveLength(25);
    expect((await page(a, big.chatId, "?limit=12").expect(200)).body.items).toHaveLength(12);
    for (const bad of ["abc", "2.5", "1e2x", "1&limit=2", "NaN", "Infinity"]) {
      const res = await page(a, big.chatId, `?limit=${bad}`).expect(422);
      expect(res.body.code).toBe("VALIDATION_ERROR");
    }
    await page(a, big.chatId, "?before=a&before=b").expect(422);
  });

  it("ignores query parameters it does not know", async () => {
    const { a, counts } = await setup();
    const big = counts.find((c) => c.n === 77)!;
    await page(a, big.chatId, "?q=hello&foo=bar").expect(200);
  });

  it("says INVALID_CURSOR for anything that is not a message of this chat", async () => {
    const { a, chatIds, counts } = await setup();
    const big = counts.find((c) => c.n === 77)!;
    const otherChat = chatIds.find((id) => id !== big.chatId)!;
    const [elsewhere] = await t.db
      .select()
      .from(messages)
      .where(eq(messages.chatId, otherChat))
      .limit(1);
    const stranger = await t.signUp();
    const [strangers] = await t.db
      .select({ chatId: chatMembers.chatId })
      .from(chatMembers)
      .where(eq(chatMembers.userId, stranger.user.id))
      .limit(1);
    const [theirs] = await t.db
      .select()
      .from(messages)
      .where(eq(messages.chatId, strangers!.chatId))
      .limit(1);

    for (const cursor of [
      "nope",
      "%00",
      "0192f1c0-6f3e-7a52-9d1b-3c1d4f5a6b7c",
      "0".repeat(300),
      elsewhere!.id,
      theirs!.id,
    ]) {
      const res = await page(a, big.chatId, `?before=${encodeURIComponent(cursor)}`).expect(400);
      expect(res.body).toEqual({
        statusCode: 400,
        code: "INVALID_CURSOR",
        message: "That page can't be loaded. Refresh the chat.",
      });
    }
  });

  it("is 404 CHAT_NOT_FOUND for an unknown chat, somebody else's chat and a malformed id", async () => {
    const { a, chatIds } = await setup();
    const other = await t.signUp();
    const bodies: unknown[] = [];
    for (const id of [
      chatIds[0]!,
      "0192f1c0-6f3e-7a52-9d1b-3c1d4f5a6b7c",
      "zzz",
      "%00",
      "0".repeat(300),
    ]) {
      const res = await page(other, encodeURIComponent(id)).expect(404);
      bodies.push(res.body);
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(bodies[0]).toMatchObject({ statusCode: 404, code: "CHAT_NOT_FOUND" });
    // And the owner still reads it.
    await page(a, chatIds[0]!).expect(200);
  });

  it("starts at the point the viewer cleared the chat", async () => {
    const { a, counts } = await setup();
    const big = counts.find((c) => c.n === 77)!;
    const before = (await page(a, big.chatId).expect(200)).body as MessagePage;
    // What POST /chats/:id/clear does, written straight to the table so this file needs only the
    // messages endpoint. The clear endpoint has its own tests.
    await t.db
      .update(chatMembers)
      .set({ clearedBeforeSeq: sql`(select last_seq from chats where id = ${big.chatId})` })
      .where(and(eq(chatMembers.chatId, big.chatId), eq(chatMembers.userId, a.user.id)));
    expect((await page(a, big.chatId).expect(200)).body).toEqual({ items: [], nextCursor: null });
    // A cursor from before the clear leads to nothing, not to the old messages.
    const old = await page(a, big.chatId, `?before=${before.items[0]!.id}`).expect(200);
    expect(old.body).toEqual({ items: [], nextCursor: null });
  });

  it("shows each viewer their own ids for the same people", async () => {
    const one = await setup();
    const two = await setup();
    const contactRows = async (a: TestAccount) =>
      new Set(
        (
          await t.db
            .select({ id: contacts.id })
            .from(contacts)
            .where(eq(contacts.ownerId, a.user.id))
        ).map((c) => c.id),
      );
    const mine = await contactRows(one.a);
    const theirs = await contactRows(two.a);

    const big = one.counts.find((c) => c.n === 77)!;
    const bigTwo = two.counts.find((c) => c.n === 77)!;
    const senders = (await page(one.a, big.chatId, "?limit=100").expect(200)).body.items.map(
      (m: MessageDto) => m.senderId,
    );
    const sendersTwo = (await page(two.a, bigTwo.chatId, "?limit=100").expect(200)).body.items.map(
      (m: MessageDto) => m.senderId,
    );
    expect(senders.every((s: string) => s === one.a.user.id || mine.has(s))).toBe(true);
    expect(sendersTwo.every((s: string) => s === two.a.user.id || theirs.has(s))).toBe(true);
    expect(senders.some((s: string) => theirs.has(s))).toBe(false);
  });

  it("shows voice messages, replies and the system note of a group as the contract describes them", async () => {
    const { a, chatIds } = await setup();
    const all: MessageDto[] = [];
    for (const id of chatIds) {
      all.push(...(await walk(a, id, 100)).flatMap((p) => p.items));
    }
    const voice = all.filter((m) => m.kind === "voice");
    expect(voice.length).toBeGreaterThan(0);
    expect(voice[0]).toMatchObject({ text: null, duration: expect.any(Number) });
    expect(voice[0]!.bars!.length).toBeGreaterThan(0);
    expect(voice[0]!.bars!.every((b) => b >= 0 && b <= 100)).toBe(true);

    const replies = all.filter((m) => m.replyTo);
    expect(replies.length).toBeGreaterThan(0);
    for (const reply of replies) {
      const original = all.find((m) => m.id === reply.replyTo!.id)!;
      expect(original.chatId).toBe(reply.chatId);
      expect(reply.replyTo).toEqual({
        id: original.id,
        senderId: original.senderId,
        kind: original.kind,
        text: original.text,
        deleted: false,
      });
    }

    const system = all.filter((m) => m.kind === "system");
    expect(system.length).toBeGreaterThan(0);
    expect(system.every((m) => m.senderId === "system" && m.text)).toBe(true);
    expect(system.map((m) => m.text)).toContain("Imogen created this group");
  });
});

describe("the chat list and the history agree", () => {
  it("shows the newest message of the history as lastMessage, also after a clear", async () => {
    const a = await t.signUp();
    const list = async () =>
      (await request(t.server).get("/chats").set(a.bearer).expect(200)).body as ChatDto[];

    const before = await list();
    expect(before).toHaveLength(11);
    for (const chat of before) {
      const newest = (await page(a, chat.id).expect(200)).body.items.at(-1);
      expect(newest, `${chat.id} has history`).toBeDefined();
      expect(chat.lastMessage, chat.id).toEqual(newest);
    }

    const target = before[0]!;
    await request(t.server).post(`/chats/${target.id}/clear`).set(a.bearer).expect(204);
    const after = (await list()).find((c) => c.id === target.id)!;
    expect(after.lastMessage).toBeNull();
    expect((await page(a, target.id).expect(200)).body).toEqual({ items: [], nextCursor: null });
    // The other chats are untouched.
    for (const chat of (await list()).filter((c) => c.id !== target.id)) {
      expect(chat.lastMessage).toEqual(before.find((c) => c.id === chat.id)!.lastMessage);
    }
  });
});
