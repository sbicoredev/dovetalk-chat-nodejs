import { randomUUID } from "node:crypto";

import type { ChatDto, ContactDto } from "@dovetalk/contracts";

import type { TestAccount, TestApp } from "./create-test-app.js";
import { http } from "./http.js";

/**
 * Real people who each have every other as a contact, the way a group of friends would.
 * `contactOf(viewer, other)` is what `viewer` calls `other`: the id events carry for them.
 */
export async function makePeople(t: TestApp, count: number) {
  const h = http(t);
  const accounts: TestAccount[] = [];
  for (let i = 0; i < count; i += 1) {
    const digits = String(Math.floor(Math.random() * 9_000_000) + 1_000_000);
    accounts.push(await t.signUp({ name: `Person ${i + 1}`, phone: `+1 555 ${digits}` }));
  }
  const book = new Map<string, ContactDto>();
  const key = (viewer: TestAccount, other: TestAccount) => `${viewer.user.id}>${other.user.id}`;
  for (const viewer of accounts) {
    for (const other of accounts) {
      if (viewer === other) {
        continue;
      }
      const res = await h
        .as(viewer)
        .post("/contacts")
        .send({ name: `${other.user.name} (for ${viewer.user.name})`, phone: other.user.phone })
        .expect(201);
      book.set(key(viewer, other), res.body as ContactDto);
    }
  }

  const contactOf = (viewer: TestAccount, other: TestAccount): ContactDto => {
    const found = book.get(key(viewer, other));
    if (!found) {
      throw new Error("No such contact.");
    }
    return found;
  };

  /** `viewer` starts a direct chat with `other` (the one they already have, if any). */
  const direct = async (viewer: TestAccount, other: TestAccount): Promise<ChatDto> =>
    (
      await h
        .as(viewer)
        .post("/chats")
        .send({ type: "direct", contactId: contactOf(viewer, other).id })
        .expect(201)
    ).body as ChatDto;

  /** `creator` makes a group of the others, and returns it as the creator sees it. */
  const group = async (
    creator: TestAccount,
    others: TestAccount[],
    name = "Group",
  ): Promise<ChatDto> =>
    (
      await h
        .as(creator)
        .post("/chats")
        .send({
          type: "group",
          name,
          memberIds: others.map((other) => contactOf(creator, other).id),
        })
        .expect(201)
    ).body as ChatDto;

  /** A unique id for a message, for tests that care about replays. */
  const clientId = () => randomUUID();

  return { accounts, clientId, contactOf, direct, group, h };
}
