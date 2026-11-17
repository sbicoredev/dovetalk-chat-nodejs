import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ChatDto, ContactDto } from "@dovetalk/contracts";
import { PG_POOL } from "@dovetalk/core";

import { createTestApp, type TestAccount, type TestApp } from "./support/create-test-app.js";

/**
 * The hot query of the whole app: `GET /chats` must cost the same number of database
 * queries for 2 chats as for 30. Core asserts it for the service; this asserts it over HTTP, so
 * the guard, the controller and anything added later to the route are counted too.
 */

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const get = (a: TestAccount, path: string) => request(t.server).get(path).set(a.bearer);
const post = (a: TestAccount, path: string) => request(t.server).post(path).set(a.bearer);

const chatsOf = async (a: TestAccount) => (await get(a, "/chats").expect(200)).body as ChatDto[];
const contactsOf = async (a: TestAccount) =>
  (await get(a, "/contacts").expect(200)).body as ContactDto[];

interface Pool {
  connect: () => Promise<{ release: () => void }>;
}

/**
 * Runs `action` and returns the SQL of every statement it sent to Postgres. Every statement,
 * pooled or inside a transaction, goes through the `query` method of the pg client class, so the
 * spy goes there. The class is found through a real connection, because the api does not depend on
 * `pg` itself.
 */
async function statementsDuring(action: () => Promise<unknown>): Promise<string[]> {
  const client = await t.app.get<Pool>(PG_POOL).connect();
  const prototype = Object.getPrototypeOf(client) as { query: (...args: unknown[]) => unknown };
  client.release();
  const spy = vi.spyOn(prototype, "query");
  try {
    await action();
    return spy.mock.calls.map(([first]) =>
      typeof first === "string" ? first : String((first as { text?: string }).text),
    );
  } finally {
    spy.mockRestore();
  }
}

/** The statements of one `GET /chats`, after a first call that warms anything cached. */
async function listStatements(a: TestAccount): Promise<string[]> {
  await get(a, "/chats").expect(200);
  return statementsDuring(() => get(a, "/chats").expect(200));
}

/** A new account with exactly `count` chats on its list. */
async function accountWithChats(count: number): Promise<TestAccount> {
  const a = await t.signUp();
  const contacts = await contactsOf(a);
  let list = await chatsOf(a);

  // Seeded accounts start with 11. Delete down to the number wanted, keeping both kinds.
  const surplus = list.length - count;
  if (surplus > 0) {
    const keep = new Set<string>();
    for (const type of ["direct", "group"] as const) {
      const first = list.find((c) => c.type === type);
      if (first) {
        keep.add(first.id);
      }
    }
    const doomed = list.filter((c) => !keep.has(c.id)).slice(0, surplus);
    for (const chat of doomed) {
      await request(t.server).delete(`/chats/${chat.id}`).set(a.bearer);
    }
  }

  // Or add: a direct chat for every contact without one, then groups.
  const direct = new Set(list.filter((c) => c.type === "direct").map((c) => c.memberIds[0]));
  for (const contact of contacts) {
    if ((await chatsOf(a)).length >= count) {
      break;
    }
    if (direct.has(contact.id)) {
      continue;
    }
    await post(a, "/chats").send({ type: "direct", contactId: contact.id }).expect(201);
  }
  for (let n = 0; (await chatsOf(a)).length < count; n += 1) {
    const members = [contacts[n % contacts.length]!.id, contacts[(n + 1) % contacts.length]!.id];
    await post(a, "/chats")
      .send({ type: "group", name: `Extra ${n}`, memberIds: members })
      .expect(201);
  }

  list = await chatsOf(a);
  const types = new Set(list.map((c) => c.type));
  if (list.length !== count || types.size !== 2) {
    throw new Error(`Expected ${count} chats of both types, got ${list.length}: ${[...types]}.`);
  }
  return a;
}

describe("GET /chats query count", () => {
  it("runs the same number of queries for 2 chats as for 30", async () => {
    const small = await accountWithChats(2);
    const large = await accountWithChats(30);

    const forSmall = await listStatements(small);
    const forLarge = await listStatements(large);

    // Guards against a spy that sees nothing, which would make "equal" meaningless.
    expect(forSmall.length).toBeGreaterThan(0);
    expect(
      forLarge.length,
      `2 chats ran:\n${forSmall.join("\n")}\n\n30 chats ran:\n${forLarge.join("\n")}`,
    ).toBe(forSmall.length);
  });

  it("does not grow with the number of messages or members either", async () => {
    const large = await accountWithChats(30);
    const before = await listStatements(large);

    // Group members multiply the "other members" rows without adding chats.
    const contacts = await contactsOf(large);
    const group = (await chatsOf(large)).find((c) => c.type === "group")!;
    await post(large, `/chats/${group.id}/members`)
      .send({ memberIds: contacts.map((c) => c.id) })
      .expect(200);

    expect(await listStatements(large)).toHaveLength(before.length);
  });
});
