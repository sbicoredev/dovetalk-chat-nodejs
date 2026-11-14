import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestDatabase, type TestDatabase } from "@dovetalk/testkit";

import { createDatabase, type DatabaseHandle, newId, runMigrations, schema } from "../src/index.js";

const {
  users,
  chats,
  messages,
  attachments,
  messageReactions,
  messageHidden,
  statuses,
  statusViews,
} = schema;

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

async function pgCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    const { cause } = error as { cause?: { code?: string } };
    return cause?.code ?? (error as { code?: string }).code;
  }
  return undefined;
}

async function makeUser() {
  const [row] = await handle.db
    .insert(users)
    .values({
      email: `${newId()}@example.com`,
      passwordHash: "$argon2id$stub",
      name: "Test Person",
      hue: 10,
    })
    .returning();
  return row!;
}

async function makeAttachment(
  ownerId: string,
  over: Partial<typeof attachments.$inferInsert> = {},
) {
  const [row] = await handle.db
    .insert(attachments)
    .values({
      ownerId,
      storageKey: `uploads/${ownerId}/${newId()}`,
      name: "notes.txt",
      size: 5,
      mime: "text/plain",
      ...over,
    })
    .returning();
  return row!;
}

async function makeChatWithMessage(
  senderId: string,
  over: Partial<typeof messages.$inferInsert> = {},
) {
  const [chat] = await handle.db
    .insert(chats)
    .values({ type: "group", name: "Hikers", hue: 1, createdBy: senderId, lastSeq: 1 })
    .returning();
  const [message] = await handle.db
    .insert(messages)
    .values({ chatId: chat!.id, seq: 1, senderId, kind: "text", text: "hi", ...over })
    .returning();
  return { chat: chat!, message: message! };
}

describe("attachments", () => {
  it("needs a positive size and positive dimensions", async () => {
    const owner = await makeUser();
    expect(await pgCode(() => makeAttachment(owner.id, { size: 0 }))).toBe(CHECK);
    expect(await pgCode(() => makeAttachment(owner.id, { width: 0 }))).toBe(CHECK);
    expect(await pgCode(() => makeAttachment(owner.id, { height: -1 }))).toBe(CHECK);
    await expect(makeAttachment(owner.id, { width: 10, height: 20 })).resolves.toBeDefined();
  });

  it("keeps storage keys unique", async () => {
    const owner = await makeUser();
    const first = await makeAttachment(owner.id);
    expect(await pgCode(() => makeAttachment(owner.id, { storageKey: first.storageKey }))).toBe(
      UNIQUE,
    );
  });

  it("goes with its owner", async () => {
    const owner = await makeUser();
    const file = await makeAttachment(owner.id);
    await handle.db.delete(users).where(eq(users.id, owner.id));
    const left = await handle.db.select().from(attachments).where(eq(attachments.id, file.id));
    expect(left).toHaveLength(0);
  });

  it("is let go by the message and the profile that point at it, not deleted with them", async () => {
    const owner = await makeUser();
    const file = await makeAttachment(owner.id);
    const { message } = await makeChatWithMessage(owner.id, {
      kind: "file",
      attachmentId: file.id,
    });
    await handle.db
      .update(users)
      .set({ avatarAttachmentId: file.id })
      .where(eq(users.id, owner.id));

    await handle.db.delete(attachments).where(eq(attachments.id, file.id));

    const [row] = await handle.db.select().from(messages).where(eq(messages.id, message.id));
    expect(row?.attachmentId).toBeNull();
    const [person] = await handle.db.select().from(users).where(eq(users.id, owner.id));
    expect(person?.avatarAttachmentId).toBeNull();
  });
});

describe("reactions", () => {
  it("allows one reaction per person and message", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const { message } = await makeChatWithMessage(a.id);
    await handle.db
      .insert(messageReactions)
      .values({ messageId: message.id, userId: a.id, emoji: "👍" });
    await handle.db
      .insert(messageReactions)
      .values({ messageId: message.id, userId: b.id, emoji: "👍" });
    expect(
      await pgCode(() =>
        handle.db
          .insert(messageReactions)
          .values({ messageId: message.id, userId: a.id, emoji: "❤️" }),
      ),
    ).toBe(UNIQUE);
  });

  it("refuses an empty or very long emoji", async () => {
    const a = await makeUser();
    const { message } = await makeChatWithMessage(a.id);
    const react = (emoji: string) =>
      handle.db.insert(messageReactions).values({ messageId: message.id, userId: a.id, emoji });
    expect(await pgCode(() => react(""))).toBe(CHECK);
    expect(await pgCode(() => react("x".repeat(33)))).toBe(CHECK);
  });

  it("goes with its message", async () => {
    const a = await makeUser();
    const { message } = await makeChatWithMessage(a.id);
    await handle.db
      .insert(messageReactions)
      .values({ messageId: message.id, userId: a.id, emoji: "👍" });
    await handle.db.delete(messages).where(eq(messages.id, message.id));
    expect(
      await handle.db
        .select()
        .from(messageReactions)
        .where(eq(messageReactions.messageId, message.id)),
    ).toHaveLength(0);
  });
});

describe("hidden messages", () => {
  it("hides a message once for a person, and for nobody else", async () => {
    const a = await makeUser();
    const b = await makeUser();
    const { message } = await makeChatWithMessage(a.id);
    await handle.db.insert(messageHidden).values({ userId: b.id, messageId: message.id });
    expect(
      await pgCode(() =>
        handle.db.insert(messageHidden).values({ userId: b.id, messageId: message.id }),
      ),
    ).toBe(UNIQUE);
    await expect(
      handle.db.insert(messageHidden).values({ userId: a.id, messageId: message.id }),
    ).resolves.toBeDefined();
  });
});

describe("statuses", () => {
  const inAnHour = () => new Date(Date.now() + 3_600_000);

  it("accepts the six colours and refuses others", async () => {
    const a = await makeUser();
    const note = (color: number) =>
      handle.db
        .insert(statuses)
        .values({ ownerId: a.id, text: "hi", color, expiresAt: inAnHour() });
    for (const color of [0, 5]) {
      await expect(note(color)).resolves.toBeDefined();
    }
    expect(await pgCode(() => note(6))).toBe(CHECK);
    expect(await pgCode(() => note(-1))).toBe(CHECK);
  });

  it("needs 1 to 120 characters and an expiry after its creation", async () => {
    const a = await makeUser();
    const note = (over: Partial<typeof statuses.$inferInsert>) =>
      handle.db
        .insert(statuses)
        .values({ ownerId: a.id, text: "hi", color: 0, expiresAt: inAnHour(), ...over });
    expect(await pgCode(() => note({ text: "" }))).toBe(CHECK);
    expect(await pgCode(() => note({ text: "x".repeat(121) }))).toBe(CHECK);
    await expect(note({ text: "x".repeat(120) })).resolves.toBeDefined();
    expect(
      await pgCode(() => note({ createdAt: new Date(), expiresAt: new Date(Date.now() - 1000) })),
    ).toBe(CHECK);
  });

  it("records a view once, and goes with the note and the viewer", async () => {
    const author = await makeUser();
    const viewer = await makeUser();
    const [note] = await handle.db
      .insert(statuses)
      .values({ ownerId: author.id, text: "hi", color: 1, expiresAt: inAnHour() })
      .returning();
    await handle.db.insert(statusViews).values({ statusId: note!.id, viewerId: viewer.id });
    expect(
      await pgCode(() =>
        handle.db.insert(statusViews).values({ statusId: note!.id, viewerId: viewer.id }),
      ),
    ).toBe(UNIQUE);

    await handle.db.delete(statuses).where(eq(statuses.id, note!.id));
    const { rows } = await handle.pool.query("select count(*)::int as n from status_views");
    expect(rows[0].n).toBe(0);
  });

  it("goes with the person it was seeded for", async () => {
    const bot = await makeUser();
    const owner = await makeUser();
    await handle.db.insert(statuses).values({
      ownerId: bot.id,
      audienceId: owner.id,
      text: "Pasta night.",
      color: 3,
      expiresAt: inAnHour(),
    });
    await handle.db.delete(users).where(eq(users.id, owner.id));
    const left = await handle.db.select().from(statuses).where(eq(statuses.ownerId, bot.id));
    expect(left).toHaveLength(0);
  });
});

describe("the migration", () => {
  it("adds the profile photo column", async () => {
    const { rows } = await handle.pool.query(
      "select column_name from information_schema.columns where table_name = 'users' and column_name = 'avatar_attachment_id'",
    );
    expect(rows).toHaveLength(1);
  });
});
