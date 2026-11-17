import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { OnboardingService } from "@dovetalk/core";
import { schema } from "@dovetalk/db";

import { createTestApp, TEST_PASSWORD, type TestApp } from "./support/create-test-app.js";

const { users, contacts, chats, chatMembers, messages, messageReactions, statuses, statusViews } =
  schema;

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

/** What a person owns in the database, counted the same way for every kind of account. */
async function stored(userId: string) {
  const count = async (query: Promise<{ n: number }[]>) => (await query)[0]!.n;
  return {
    contacts: await count(
      t.db
        .select({ n: sql<number>`count(*)::int` })
        .from(contacts)
        .where(eq(contacts.ownerId, userId)),
    ),
    chats: await count(
      t.db
        .select({ n: sql<number>`count(*)::int` })
        .from(chatMembers)
        .where(eq(chatMembers.userId, userId)),
    ),
    messages: await count(
      t.db
        .select({ n: sql<number>`count(*)::int` })
        .from(messages)
        .innerJoin(chatMembers, eq(chatMembers.chatId, messages.chatId))
        .where(eq(chatMembers.userId, userId)),
    ),
  };
}

const SEEDED = { contacts: 14, chats: 11, messages: 153 };

/** The reactions on a person's messages, the statuses made for them and the ones they have seen. */
async function storedExtras(userId: string) {
  const count = async (query: Promise<{ n: number }[]>) => (await query)[0]!.n;
  return {
    reactions: await count(
      t.db
        .select({ n: sql<number>`count(*)::int` })
        .from(messageReactions)
        .innerJoin(messages, eq(messages.id, messageReactions.messageId))
        .innerJoin(
          chatMembers,
          sql`${chatMembers.chatId} = ${messages.chatId} and ${chatMembers.userId} = ${userId}`,
        ),
    ),
    statuses: await count(
      t.db
        .select({ n: sql<number>`count(*)::int` })
        .from(statuses)
        .where(eq(statuses.audienceId, userId)),
    ),
    views: await count(
      t.db
        .select({ n: sql<number>`count(*)::int` })
        .from(statusViews)
        .where(eq(statusViews.viewerId, userId)),
    ),
  };
}

const SEEDED_EXTRAS = { reactions: 3, statuses: 6, views: 1 };

describe("starting data for new accounts", () => {
  it("gives a registered account the seeded contacts, chats and messages", async () => {
    const account = await t.signUp();
    expect(await stored(account.user.id)).toEqual(SEEDED);
  });

  it("also gives it the 3 reactions and 6 statuses, in the same transaction", async () => {
    const account = await t.signUp();
    expect(await storedExtras(account.user.id)).toEqual(SEEDED_EXTRAS);
    const list = await request(t.server).get("/statuses").set(account.bearer).expect(200);
    expect(list.body).toHaveLength(6);
    const chatsRes = await request(t.server).get("/chats").set(account.bearer).expect(200);
    const hikers = chatsRes.body.find((c: { name: string | null }) => c.name === "Weekend hikers");
    const page = await request(t.server)
      .get(`/chats/${hikers.id}/messages?limit=100`)
      .set(account.bearer)
      .expect(200);
    const inMessage = page.body.items.find((m: { text: string | null }) => m.text === "In!");
    expect(Object.keys(inMessage.reactions)).toEqual(["🎉"]);
    expect(inMessage.reactions["🎉"]).toHaveLength(2);
  });

  it("gives a guest the same", async () => {
    const res = await request(t.server).post("/auth/guest").expect(201);
    expect(await stored(res.body.user.id)).toEqual(SEEDED);
    expect(await storedExtras(res.body.user.id)).toEqual(SEEDED_EXTRAS);
  });

  it("shares the 14 bots between accounts instead of making new ones", async () => {
    await t.signUp();
    await t.signUp();
    const [{ n }] = await t.db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.isBot, true));
    expect(n).toBe(14);
  });

  it("keeps people's data apart: two accounts never share a chat", async () => {
    const a = await t.signUp();
    const b = await t.signUp();
    const shared = await t.db
      .select({ id: chats.id })
      .from(chats)
      .innerJoin(chatMembers, eq(chatMembers.chatId, chats.id))
      .where(eq(chatMembers.userId, a.user.id))
      .intersect(
        t.db
          .select({ id: chats.id })
          .from(chats)
          .innerJoin(chatMembers, eq(chatMembers.chatId, chats.id))
          .where(eq(chatMembers.userId, b.user.id)),
      );
    expect(shared).toHaveLength(0);
  });
});

describe("the account and its data are one transaction", () => {
  it("leaves no account behind when onboarding fails", async () => {
    const spy = vi
      .spyOn(t.app.get(OnboardingService), "onboard")
      .mockRejectedValueOnce(new Error("insert failed"));
    try {
      await request(t.server)
        .post("/auth/register")
        .send({ email: "rolled-back@example.com", password: TEST_PASSWORD, name: "Rolled Back" })
        .expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(
      await t.db.select().from(users).where(eq(users.email, "rolled-back@example.com")),
    ).toHaveLength(0);

    // And the same address registers fine afterwards.
    await request(t.server)
      .post("/auth/register")
      .send({ email: "rolled-back@example.com", password: TEST_PASSWORD, name: "Rolled Back" })
      .expect(201);
  });

  it("leaves no guest behind when onboarding fails", async () => {
    const before = await t.db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.isGuest, true));
    const spy = vi
      .spyOn(t.app.get(OnboardingService), "onboard")
      .mockRejectedValueOnce(new Error("insert failed"));
    try {
      await request(t.server).post("/auth/guest").expect(500);
    } finally {
      spy.mockRestore();
    }
    const after = await t.db
      .select({ n: sql<number>`count(*)::int` })
      .from(users)
      .where(eq(users.isGuest, true));
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("writes nothing for a taken email", async () => {
    const taken = await t.signUp();
    const [{ before }] = await t.db.select({ before: sql<number>`count(*)::int` }).from(contacts);
    await request(t.server)
      .post("/auth/register")
      .send({ email: taken.email, password: TEST_PASSWORD, name: "Second" })
      .expect(409);
    const [{ after }] = await t.db.select({ after: sql<number>`count(*)::int` }).from(contacts);
    expect(after).toBe(before);
  });
});
