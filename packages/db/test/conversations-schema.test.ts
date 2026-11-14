import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { byCodeUnit, createTestDatabase, type TestDatabase } from "@dovetalk/testkit";

import {
  createDatabase,
  type DatabaseHandle,
  newId,
  runMigrations,
  type SystemEvent,
  schema,
} from "../src/index.js";

const { users, contacts, chats, chatMembers, messages } = schema;

let testDb: TestDatabase;
let handle: DatabaseHandle;

beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDatabase({ url: testDb.url, poolMax: 5 });
  await runMigrations(handle.db, handle.pool);
});
afterAll(async () => {
  await handle.close();
  await testDb.drop();
});

const UNIQUE = "23505";
const CHECK = "23514";
const FOREIGN_KEY = "23503";

/** The Postgres error code behind a failed query. Drizzle wraps the driver error in `cause`. */
async function pgCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    const { cause } = error as { cause?: { code?: string } };
    return cause?.code ?? (error as { code?: string }).code;
  }
  return undefined;
}

async function makeUser(over: Partial<typeof users.$inferInsert> = {}) {
  const [row] = await handle.db
    .insert(users)
    .values({
      email: `${newId()}@example.com`,
      passwordHash: "$argon2id$stub",
      name: "Test Person",
      hue: 10,
      ...over,
    })
    .returning();
  return row!;
}

function makeBot(over: Partial<typeof users.$inferInsert> = {}) {
  return makeUser({ email: null, passwordHash: null, isBot: true, ...over });
}

async function makeDirectChat(a: string, b: string) {
  const [x, y] = [a, b].sort(byCodeUnit);
  const [row] = await handle.db
    .insert(chats)
    .values({ type: "direct", directKey: `${x}:${y}` })
    .returning();
  return row!;
}

async function makeGroup(createdBy: string, over: Partial<typeof chats.$inferInsert> = {}) {
  const [row] = await handle.db
    .insert(chats)
    .values({ type: "group", name: "Weekend hikers", hue: 120, createdBy, ...over })
    .returning();
  return row!;
}

describe("ghost owner", () => {
  it("only a bot can be a ghost", async () => {
    const owner = await makeUser();
    expect(
      await pgCode(() =>
        handle.db.insert(users).values({
          email: `${newId()}@example.com`,
          passwordHash: "x",
          name: "Not a bot",
          hue: 1,
          ghostOwnerId: owner.id,
        }),
      ),
    ).toBe(CHECK);
    const ghost = await makeBot({ ghostOwnerId: owner.id });
    expect(ghost.ghostOwnerId).toBe(owner.id);
  });

  it("goes with its owner, together with the contact rows that pointed at it", async () => {
    const owner = await makeUser();
    const ghost = await makeBot({ ghostOwnerId: owner.id });
    await handle.db
      .insert(contacts)
      .values({ ownerId: owner.id, linkedUserId: ghost.id, name: "Nobody", phone: "5550100000" });

    await handle.db.delete(users).where(eq(users.id, owner.id));

    expect(await handle.db.select().from(users).where(eq(users.id, ghost.id))).toHaveLength(0);
    expect(
      await handle.db.select().from(contacts).where(eq(contacts.linkedUserId, ghost.id)),
    ).toHaveLength(0);
  });
});

describe("contacts", () => {
  it("fills defaults and derives phone_digits from the owner's own number", async () => {
    const owner = await makeUser();
    const bot = await makeBot();
    const [row] = await handle.db
      .insert(contacts)
      .values({ ownerId: owner.id, linkedUserId: bot.id, name: "Imogen", phone: "(555) 010-0142" })
      .returning();
    expect(row).toMatchObject({
      about: null,
      hue: null,
      avatarUrl: null,
      blocked: false,
      saved: true,
      phoneDigits: "5550100142",
    });
    expect(row!.createdAt).toBeInstanceOf(Date);
  });

  it("allows a person to be in an address book once, and in many address books", async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const bot = await makeBot();
    await handle.db.insert(contacts).values({ ownerId: a.id, linkedUserId: bot.id, name: "One" });
    await handle.db.insert(contacts).values({ ownerId: b.id, linkedUserId: bot.id, name: "One" });
    expect(
      await pgCode(() =>
        handle.db.insert(contacts).values({ ownerId: a.id, linkedUserId: bot.id, name: "Again" }),
      ),
    ).toBe(UNIQUE);
  });

  it("does not require a phone number, or a unique one", async () => {
    const owner = await makeUser();
    const [x, y] = [await makeBot(), await makeBot()];
    await handle.db
      .insert(contacts)
      .values({ ownerId: owner.id, linkedUserId: x.id, name: "X", phone: "5550100001" });
    // The same number twice in one address book is the API's rule (a lock), not a constraint.
    await handle.db
      .insert(contacts)
      .values({ ownerId: owner.id, linkedUserId: y.id, name: "Y", phone: "5550100001" });
    await handle.db
      .insert(contacts)
      .values({ ownerId: owner.id, linkedUserId: (await makeBot()).id, name: "Z", phone: null });
  });

  it("is never your own entry, and keeps the hue on the colour wheel", async () => {
    const owner = await makeUser();
    expect(
      await pgCode(() =>
        handle.db
          .insert(contacts)
          .values({ ownerId: owner.id, linkedUserId: owner.id, name: "Me" }),
      ),
    ).toBe(CHECK);
    const bot = await makeBot();
    expect(
      await pgCode(() =>
        handle.db
          .insert(contacts)
          .values({ ownerId: owner.id, linkedUserId: bot.id, name: "Hue", hue: 360 }),
      ),
    ).toBe(CHECK);
    expect(
      await pgCode(() =>
        handle.db.insert(contacts).values({ ownerId: owner.id, linkedUserId: newId(), name: "?" }),
      ),
    ).toBe(FOREIGN_KEY);
  });

  it("disappears from an address book when either person is deleted", async () => {
    const [owner, other] = [await makeUser(), await makeUser()];
    const bot = await makeBot();
    await handle.db.insert(contacts).values([
      { ownerId: owner.id, linkedUserId: other.id, name: "Other" },
      { ownerId: owner.id, linkedUserId: bot.id, name: "Bot" },
      { ownerId: other.id, linkedUserId: owner.id, name: "Owner" },
    ]);
    await handle.db.delete(users).where(eq(users.id, other.id));
    const left = await handle.db.select().from(contacts).where(eq(contacts.ownerId, owner.id));
    expect(left.map((c) => c.name)).toEqual(["Bot"]);
    expect(
      await handle.db.select().from(contacts).where(eq(contacts.linkedUserId, owner.id)),
    ).toHaveLength(0);
  });
});

describe("chats", () => {
  it("fills defaults", async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const chat = await makeDirectChat(a.id, b.id);
    expect(chat).toMatchObject({ lastSeq: 0, name: null, hue: null, createdBy: null });
  });

  it("lets a pair have one direct chat, however the two of them race to open it", async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const [x, y] = [a.id, b.id].sort(byCodeUnit);
    const key = `${x}:${y}`;

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        handle.db
          .insert(chats)
          .values({ type: "direct", directKey: key })
          .onConflictDoNothing({ target: chats.directKey })
          .returning({ id: chats.id }),
      ),
    );
    expect(results.filter((rows) => rows.length === 1)).toHaveLength(1);
    expect(await handle.db.select().from(chats).where(eq(chats.directKey, key))).toHaveLength(1);
    expect(
      await pgCode(() => handle.db.insert(chats).values({ type: "direct", directKey: key })),
    ).toBe(UNIQUE);
  });

  it("gives direct chats a key and groups none", async () => {
    const owner = await makeUser();
    expect(await pgCode(() => handle.db.insert(chats).values({ type: "direct" }))).toBe(CHECK);
    expect(
      await pgCode(() =>
        handle.db.insert(chats).values({
          type: "group",
          name: "G",
          hue: 1,
          directKey: "a:b",
          createdBy: owner.id,
        }),
      ),
    ).toBe(CHECK);
    expect(
      await pgCode(() => handle.db.insert(chats).values({ type: "channel" as "direct" })),
    ).toBe(CHECK);
  });

  it("needs a group to have a name of 1 to 60 characters and a hue", async () => {
    const owner = await makeUser();
    const group = (over: Partial<typeof chats.$inferInsert>) => () =>
      handle.db
        .insert(chats)
        .values({ type: "group", name: "Ok", hue: 5, createdBy: owner.id, ...over });
    expect(await pgCode(group({ name: null }))).toBe(CHECK);
    expect(await pgCode(group({ name: "   " }))).toBe(CHECK);
    expect(await pgCode(group({ name: "x".repeat(61) }))).toBe(CHECK);
    expect(await pgCode(group({ hue: null }))).toBe(CHECK);
    expect(await pgCode(group({ hue: 360 }))).toBe(CHECK);
    await group({ name: "x".repeat(60) })();
    await group({ name: "x" })();
  });

  it("never lets the sequence go negative", async () => {
    const owner = await makeUser();
    const group = await makeGroup(owner.id);
    expect(
      await pgCode(() =>
        handle.db.update(chats).set({ lastSeq: -1 }).where(eq(chats.id, group.id)),
      ),
    ).toBe(CHECK);
  });

  it("hands out sequence numbers one at a time, even when senders race", async () => {
    const owner = await makeUser();
    const group = await makeGroup(owner.id);
    const seqs = await Promise.all(
      Array.from({ length: 12 }, () =>
        handle.db.transaction(async (tx) => {
          const [row] = await tx
            .update(chats)
            .set({ lastSeq: sql`${chats.lastSeq} + 1` })
            .where(eq(chats.id, group.id))
            .returning({ seq: chats.lastSeq });
          return row!.seq;
        }),
      ),
    );
    expect([...seqs].sort((p, q) => p - q)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it("keeps the chat when its creator is deleted", async () => {
    const owner = await makeUser();
    const group = await makeGroup(owner.id);
    await handle.db.delete(users).where(eq(users.id, owner.id));
    const [row] = await handle.db.select().from(chats).where(eq(chats.id, group.id));
    expect(row).toMatchObject({ id: group.id, createdBy: null });
  });
});

describe("chat_members", () => {
  it("fills defaults and has one row per person per chat", async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const chat = await makeDirectChat(a.id, b.id);
    const [row] = await handle.db
      .insert(chatMembers)
      .values({ chatId: chat.id, userId: a.id })
      .returning();
    expect(row).toMatchObject({
      unreadCount: 0,
      archived: false,
      pinned: false,
      muted: false,
      clearedBeforeSeq: 0,
      hiddenAt: null,
      leftAt: null,
    });
    expect(
      await pgCode(() => handle.db.insert(chatMembers).values({ chatId: chat.id, userId: a.id })),
    ).toBe(UNIQUE);
  });

  it("rejects negative counters", async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const chat = await makeDirectChat(a.id, b.id);
    expect(
      await pgCode(() =>
        handle.db.insert(chatMembers).values({ chatId: chat.id, userId: a.id, unreadCount: -1 }),
      ),
    ).toBe(CHECK);
    expect(
      await pgCode(() =>
        handle.db
          .insert(chatMembers)
          .values({ chatId: chat.id, userId: a.id, clearedBeforeSeq: -1 }),
      ),
    ).toBe(CHECK);
  });

  it("goes with the chat and with the person", async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const chat = await makeDirectChat(a.id, b.id);
    await handle.db.insert(chatMembers).values([
      { chatId: chat.id, userId: a.id },
      { chatId: chat.id, userId: b.id },
    ]);
    await handle.db.delete(users).where(eq(users.id, b.id));
    expect(
      await handle.db.select().from(chatMembers).where(eq(chatMembers.chatId, chat.id)),
    ).toHaveLength(1);
    await handle.db.delete(chats).where(eq(chats.id, chat.id));
    expect(
      await handle.db.select().from(chatMembers).where(eq(chatMembers.chatId, chat.id)),
    ).toHaveLength(0);
  });
});

describe("messages", () => {
  const text = (chatId: string, seq: number, senderId: string, over = {}) => ({
    chatId,
    seq,
    senderId,
    kind: "text" as const,
    text: "hello",
    ...over,
  });

  it("fills defaults", async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const chat = await makeDirectChat(a.id, b.id);
    const [row] = await handle.db
      .insert(messages)
      .values(text(chat.id, 1, a.id))
      .returning();
    expect(row).toMatchObject({
      clientId: null,
      duration: null,
      bars: null,
      attachmentId: null,
      replyToId: null,
      forwarded: false,
      edited: false,
      deleted: false,
      event: null,
    });
  });

  it("gives each message its own place in the chat", async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const [one, two] = [await makeDirectChat(a.id, b.id), await makeGroup(a.id)];
    await handle.db.insert(messages).values(text(one.id, 1, a.id));
    expect(await pgCode(() => handle.db.insert(messages).values(text(one.id, 1, b.id)))).toBe(
      UNIQUE,
    );
    // Another chat has its own numbering.
    await handle.db.insert(messages).values(text(two.id, 1, a.id));
    expect(await pgCode(() => handle.db.insert(messages).values(text(one.id, 0, a.id)))).toBe(
      CHECK,
    );
  });

  it("makes a retried send harmless: one client id per sender per chat", async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const chat = await makeDirectChat(a.id, b.id);
    const clientId = `client-${newId()}`;
    await handle.db.insert(messages).values(text(chat.id, 1, a.id, { clientId }));

    expect(
      await pgCode(() => handle.db.insert(messages).values(text(chat.id, 2, a.id, { clientId }))),
    ).toBe(UNIQUE);
    // `ON CONFLICT DO NOTHING` is what the send path relies on to detect the replay.
    const replay = await handle.db
      .insert(messages)
      .values(text(chat.id, 3, a.id, { clientId }))
      .onConflictDoNothing()
      .returning();
    expect(replay).toHaveLength(0);

    // The same client id from someone else is a different message.
    await handle.db.insert(messages).values(text(chat.id, 4, b.id, { clientId }));
    // Messages without a client id never collide.
    await handle.db.insert(messages).values(text(chat.id, 5, a.id));
    await handle.db.insert(messages).values(text(chat.id, 6, a.id));
  });

  it("keeps system messages senderless with an event, and everything else with a sender", async () => {
    const owner = await makeUser();
    const group = await makeGroup(owner.id);
    const event = { type: "group_created", actorId: owner.id } as const;
    const system = { chatId: group.id, kind: "system" as const };

    await handle.db.insert(messages).values({ ...system, seq: 1, senderId: null, event });
    expect(
      await pgCode(() =>
        handle.db.insert(messages).values({ ...system, seq: 2, senderId: owner.id, event }),
      ),
    ).toBe(CHECK);
    expect(
      await pgCode(() =>
        handle.db.insert(messages).values({ ...system, seq: 3, senderId: null, event: null }),
      ),
    ).toBe(CHECK);
    expect(
      await pgCode(() =>
        handle.db
          .insert(messages)
          .values({ chatId: group.id, seq: 4, kind: "text", senderId: null, event }),
      ),
    ).toBe(CHECK);
    expect(
      await pgCode(() => handle.db.insert(messages).values(text(group.id, 5, owner.id, { event }))),
    ).toBe(CHECK);
    expect(
      await pgCode(() =>
        handle.db
          .insert(messages)
          .values(text(group.id, 6, owner.id, { kind: "sticker" as "text" })),
      ),
    ).toBe(CHECK);
  });

  it("stores the event as data and returns it as written", async () => {
    const owner = await makeUser();
    const other = await makeUser();
    const group = await makeGroup(owner.id);
    const event: SystemEvent = {
      type: "members_added",
      actorId: owner.id,
      targetIds: [other.id],
    };
    const [row] = await handle.db
      .insert(messages)
      .values({ chatId: group.id, seq: 1, kind: "system", senderId: null, event })
      .returning();
    expect(row!.event).toEqual(event);
  });

  it("goes with its chat, and a deleted original leaves its replies standing", async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const chat = await makeDirectChat(a.id, b.id);
    const [original] = await handle.db
      .insert(messages)
      .values(text(chat.id, 1, a.id))
      .returning();
    const [reply] = await handle.db
      .insert(messages)
      .values(text(chat.id, 2, b.id, { replyToId: original!.id }))
      .returning();

    await handle.db.delete(messages).where(eq(messages.id, original!.id));
    const [after] = await handle.db.select().from(messages).where(eq(messages.id, reply!.id));
    expect(after!.replyToId).toBeNull();

    await handle.db.delete(chats).where(eq(chats.id, chat.id));
    expect(
      await handle.db.select().from(messages).where(eq(messages.chatId, chat.id)),
    ).toHaveLength(0);
  });

  it("is removed with its sender", async () => {
    const [a, b] = [await makeUser(), await makeUser()];
    const chat = await makeDirectChat(a.id, b.id);
    await handle.db.insert(messages).values(text(chat.id, 1, a.id));
    await handle.db.insert(messages).values(text(chat.id, 2, b.id));
    await handle.db.delete(users).where(eq(users.id, a.id));
    const left = await handle.db.select().from(messages).where(eq(messages.chatId, chat.id));
    expect(left.map((m) => m.seq)).toEqual([2]);
  });
});
