import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { byCodeUnit, createTestDatabase, type TestDatabase } from "@dovetalk/testkit";

import {
  createDatabase,
  type DatabaseHandle,
  isUniqueViolation,
  newId,
  pgError,
  runMigrations,
  schema,
} from "../src/index.js";

const { users, refreshTokens } = schema;

let testDb: TestDatabase;
let handle: DatabaseHandle;

beforeAll(async () => {
  testDb = await createTestDatabase();
  handle = createDatabase({ url: testDb.url, poolMax: 3 });
  await runMigrations(handle.db, handle.pool);
});
afterAll(async () => {
  await handle.close();
  await testDb.drop();
});

const person = (over: Partial<typeof users.$inferInsert> = {}): typeof users.$inferInsert => ({
  email: `${newId()}@example.com`,
  passwordHash: "$argon2id$stub",
  name: "Test Person",
  hue: 10,
  ...over,
});

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

const UNIQUE = "23505";
const CHECK = "23514";

describe("ids", () => {
  it("makes UUIDv7 ids that sort in creation order", () => {
    const ids = Array.from({ length: 50 }, () => newId());
    expect(ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/u.test(id))).toBe(true);
    expect([...ids].sort(byCodeUnit)).toEqual(ids);
  });
});

describe("users", () => {
  it("fills defaults and reads the generated phone_digits", async () => {
    const [row] = await handle.db
      .insert(users)
      .values(person({ phone: "(555) 010-0142" }))
      .returning();
    expect(row).toMatchObject({
      about: "Hey there, I am using Dovetalk.",
      avatarAttachmentId: null,
      isBot: false,
      isGuest: false,
      guestExpiresAt: null,
      phoneDigits: "5550100142",
      preferences: { sounds: true, previews: true, enterToSend: true },
    });
    expect(row!.createdAt).toBeInstanceOf(Date);
  });

  it("keeps emails unique, and lower case", async () => {
    const email = `dup-${newId()}@example.com`;
    await handle.db.insert(users).values(person({ email }));
    expect(await pgCode(() => handle.db.insert(users).values(person({ email })))).toBe(UNIQUE);
    expect(
      await pgCode(() => handle.db.insert(users).values(person({ email: "Mixed@Example.com" }))),
    ).toBe(CHECK);
  });

  it("treats the same phone number written two ways as one number", async () => {
    await handle.db.insert(users).values(person({ phone: "+44 20 7946 0958" }));
    expect(
      await pgCode(() => handle.db.insert(users).values(person({ phone: "442079460958" }))),
    ).toBe(UNIQUE);
    // Any number of people may have no phone at all.
    await handle.db.insert(users).values(person({ phone: null }));
    await handle.db.insert(users).values(person({ phone: null }));
  });

  it("rejects numbers that are too short or too long", async () => {
    expect(await pgCode(() => handle.db.insert(users).values(person({ phone: "12345" })))).toBe(
      CHECK,
    );
    expect(
      await pgCode(() => handle.db.insert(users).values(person({ phone: "1".repeat(16) }))),
    ).toBe(CHECK);
  });

  it("requires an expiry for guests and credentials for everyone else", async () => {
    expect(await pgCode(() => handle.db.insert(users).values(person({ isGuest: true })))).toBe(
      CHECK,
    );
    expect(
      await pgCode(() =>
        handle.db.insert(users).values(person({ guestExpiresAt: new Date(Date.now() + 1000) })),
      ),
    ).toBe(CHECK);
    expect(await pgCode(() => handle.db.insert(users).values(person({ passwordHash: null })))).toBe(
      CHECK,
    );
    // Guests and bots have no password.
    await handle.db.insert(users).values(
      person({
        isGuest: true,
        guestExpiresAt: new Date(Date.now() + 60_000),
        passwordHash: null,
      }),
    );
    await handle.db
      .insert(users)
      .values({ name: "Bot", hue: 1, isBot: true, email: null, passwordHash: null });
  });

  it("keeps the hue on the colour wheel", async () => {
    expect(await pgCode(() => handle.db.insert(users).values(person({ hue: 360 })))).toBe(CHECK);
    expect(await pgCode(() => handle.db.insert(users).values(person({ hue: -1 })))).toBe(CHECK);
  });

  it("merges preferences in SQL without touching the other keys", async () => {
    const [row] = await handle.db.insert(users).values(person()).returning();
    const [updated] = await handle.db
      .update(users)
      .set({
        preferences: sql`${users.preferences} || ${JSON.stringify({ sounds: false })}::jsonb`,
      })
      .where(eq(users.id, row!.id))
      .returning();
    expect(updated!.preferences).toEqual({ sounds: false, previews: true, enterToSend: true });
  });
});

describe("refresh_tokens", () => {
  it("belongs to a user, stores one hash once, and goes with the user", async () => {
    const [user] = await handle.db.insert(users).values(person()).returning();
    const hash = `hash-${newId()}`;
    const values = {
      userId: user!.id,
      familyId: newId(),
      tokenHash: hash,
      expiresAt: new Date(Date.now() + 60_000),
    };
    await handle.db.insert(refreshTokens).values(values);
    expect(await pgCode(() => handle.db.insert(refreshTokens).values(values))).toBe(UNIQUE);
    expect(
      await pgCode(() =>
        handle.db.insert(refreshTokens).values({ ...values, tokenHash: "x", userId: newId() }),
      ),
    ).toBe("23503");

    await handle.db.delete(users).where(eq(users.id, user!.id));
    const left = await handle.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hash));
    expect(left).toHaveLength(0);
  });
});

describe("error helpers", () => {
  it("name the violated constraint through Drizzle's wrapper", async () => {
    const email = `named-${newId()}@example.com`;
    await handle.db.insert(users).values(person({ email }));
    const error = await handle.db
      .insert(users)
      .values(person({ email }))
      .catch((e: unknown) => e);
    expect(isUniqueViolation(error)).toBe(true);
    expect(isUniqueViolation(error, "users_email_key")).toBe(true);
    expect(isUniqueViolation(error, "users_phone_digits_key")).toBe(false);
    expect(pgError(error)).toMatchObject({ code: "23505", table: "users" });
    expect(pgError(new Error("plain"))).toBeNull();
  });
});
