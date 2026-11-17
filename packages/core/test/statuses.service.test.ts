import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { STATUS_TEXT_MAX, STATUS_TTL_MS } from "@dovetalk/contracts";
import { newId, schema, type UserRow } from "@dovetalk/db";
import { byCodeUnit } from "@dovetalk/testkit";

import { botId, type DomainError, SEED_PEOPLE } from "../src/index.js";
import { codeOf } from "./support/helpers.js";
import { createWorld, type World } from "./support/world.js";

const { contacts, statuses, statusViews } = schema;

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

const HOUR = 3_600_000;

/** A status written straight into the table, for people who are not the viewer. */
async function plant(
  ownerId: string,
  over: Partial<typeof statuses.$inferInsert> = {},
  agoMs = 0,
): Promise<string> {
  const createdAt = new Date(Date.now() - agoMs);
  const [row] = await w.db
    .insert(statuses)
    .values({
      ownerId,
      text: "hello",
      color: 2,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + STATUS_TTL_MS),
      ...over,
    })
    .returning({ id: statuses.id });
  return row!.id;
}

// Helpers made outside any loop, because a test body that makes a closure over `w` in a loop is
// flagged by the linter (`w` is assigned in `beforeAll`).
const removeCode = (viewer: UserRow, id: string) => codeOf(() => w.statuses.remove(viewer.id, id));
const seenCode = (viewer: UserRow, id: string) => codeOf(() => w.statuses.markSeen(viewer.id, id));
const createCode = (viewer: UserRow, input: { text: unknown; color: unknown }) =>
  codeOf(() => w.statuses.create(viewer.id, input as { text: string; color: number }));

const onboard = (user: UserRow) => w.db.transaction((tx) => w.onboarding.onboard(tx, user.id));

const texts = async (viewer: UserRow) => (await w.statuses.list(viewer.id)).map((s) => s.text);

describe("StatusesService.list: who sees what", () => {
  it("is empty for a new person with no contacts", async () => {
    const me = await w.user();
    expect(await w.statuses.list(me.id)).toEqual([]);
  });

  it("shows my own, with my user id as the owner, already seen", async () => {
    const me = await w.user();
    const made = await w.statuses.create(me.id, { text: "mine", color: 3 });
    const [listed] = await w.statuses.list(me.id);
    expect(listed).toEqual(made);
    expect(listed).toMatchObject({ ownerId: me.id, text: "mine", color: 3, seen: true });
  });

  it("shows a contact's status under my contact id for them, unseen", async () => {
    const [me, ann] = await w.people(2);
    const [annContact] = await w.befriend(me!, [ann!]);
    const id = await plant(ann!.id, { text: "ann says hi" });
    const list = await w.statuses.list(me!.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id,
      ownerId: annContact,
      text: "ann says hi",
      color: 2,
      seen: false,
    });
    expect(typeof list[0]!.createdAt).toBe("number");
  });

  it("tells two viewers different owner ids for the same author", async () => {
    const [a, b, author] = await w.people(3);
    const [contactOfA] = await w.befriend(a!, [author!]);
    const [contactOfB] = await w.befriend(b!, [author!]);
    await plant(author!.id);
    const [seenByA] = await w.statuses.list(a!.id);
    const [seenByB] = await w.statuses.list(b!.id);
    expect(seenByA!.id).toBe(seenByB!.id);
    expect(seenByA!.ownerId).toBe(contactOfA);
    expect(seenByB!.ownerId).toBe(contactOfB);
    expect(contactOfA).not.toBe(contactOfB);
  });

  it("hides people I have no contact row for", async () => {
    const [me, stranger] = await w.people(2);
    await plant(stranger!.id);
    expect(await w.statuses.list(me!.id)).toEqual([]);
  });

  it("is one way: they see mine only if they have me as a contact", async () => {
    const [me, ann] = await w.people(2);
    await w.befriend(me!, [ann!]);
    await w.statuses.create(ann!.id, { text: "from ann", color: 0 });
    await w.statuses.create(me!.id, { text: "from me", color: 0 });
    expect(await texts(me!)).toEqual(["from ann", "from me"]);
    expect(await texts(ann!)).toEqual(["from ann"]);
  });

  it("keeps a contact's status after I delete them, and for an unsaved person", async () => {
    const [me, ann, bea] = await w.people(3);
    const [annContact] = await w.befriend(me!, [ann!, bea!]);
    await plant(ann!.id, { text: "ann" });
    await plant(bea!.id, { text: "bea" });
    await w.contacts.remove(me!.id, annContact!);
    await w.db
      .update(contacts)
      .set({ saved: false })
      .where(and(eq(contacts.ownerId, me!.id), eq(contacts.linkedUserId, bea!.id)));
    const list = await w.statuses.list(me!.id);
    expect(list.map((s) => s.text)).toEqual(["ann", "bea"]);
    // The owner is still the contact row, the one the address book no longer lists.
    expect(list[0]!.ownerId).toBe(annContact);
  });

  it("shows the status of someone I only meet in a group", async () => {
    const [me, ann, bea] = await w.people(3);
    // I know Ann and Bea. Ann knows me, and Bea (whom she has not added) is in a group with her.
    const [meToAnn, meToBea] = await w.befriend(me!, [ann!, bea!]);
    await w.befriend(ann!, [me!]);
    await w.chats.create(me!.id, {
      type: "group",
      name: "Trio",
      memberIds: [meToAnn!, meToBea!],
    });
    await plant(bea!.id, { text: "from the group" });
    const [seen] = await w.statuses.list(ann!.id);
    expect(seen).toMatchObject({ text: "from the group", seen: false });
    const [contactRow] = await w.db
      .select({ id: contacts.id, saved: contacts.saved })
      .from(contacts)
      .where(and(eq(contacts.ownerId, ann!.id), eq(contacts.linkedUserId, bea!.id)));
    expect(contactRow!.saved).toBe(false);
    expect(seen!.ownerId).toBe(contactRow!.id);
  });

  it("hides a status when it has expired, and shows it again for a later expiry", async () => {
    const [me, ann] = await w.people(2);
    await w.befriend(me!, [ann!]);
    const live = await plant(ann!.id, { text: "live" });
    const gone = await plant(
      ann!.id,
      { text: "gone", expiresAt: new Date(Date.now() - 1000) },
      25 * HOUR,
    );
    expect(await texts(me!)).toEqual(["live"]);
    await w.db
      .update(statuses)
      .set({ expiresAt: new Date(Date.now() + HOUR) })
      .where(eq(statuses.id, gone));
    expect((await texts(me!)).sort(byCodeUnit)).toEqual(["gone", "live"]);
    await w.db
      .update(statuses)
      .set({ expiresAt: new Date(Date.now() - 1) })
      .where(eq(statuses.id, live));
    expect(await texts(me!)).toEqual(["gone"]);
  });

  it("hides my own status after it expired, too", async () => {
    const me = await w.user();
    await plant(me.id, { text: "old" }, 25 * HOUR);
    expect(await w.statuses.list(me.id)).toEqual([]);
  });

  it("orders by time, then id", async () => {
    const [me, ann] = await w.people(2);
    await w.befriend(me!, [ann!]);
    const at = new Date(Date.now() - 5000);
    const expiresAt = new Date(at.getTime() + STATUS_TTL_MS);
    await plant(ann!.id, { text: "newest" }, 1000);
    await plant(ann!.id, { text: "oldest" }, 9000);
    const [x, y] = [newId(), newId()].sort(byCodeUnit);
    await w.db.insert(statuses).values([
      { id: y!, ownerId: ann!.id, text: "tie-b", color: 0, createdAt: at, expiresAt },
      { id: x!, ownerId: ann!.id, text: "tie-a", color: 0, createdAt: at, expiresAt },
    ]);
    expect(await texts(me!)).toEqual(["oldest", "tie-a", "tie-b", "newest"]);
  });

  it("does not let a blocked contact hide their statuses (blocking only stops messages)", async () => {
    const [me, ann] = await w.people(2);
    const [annContact] = await w.befriend(me!, [ann!]);
    await w.contacts.setBlocked(me!.id, annContact!, true);
    await plant(ann!.id, { text: "still here" });
    expect(await texts(me!)).toEqual(["still here"]);
  });

  it("keeps a bot's per-account status for that account only", async () => {
    const [one, two] = await w.people(2);
    await w.onboarding.ensureBots();
    await onboard(one!);
    await onboard(two!);
    const mine = await w.statuses.list(one!.id);
    const theirs = await w.statuses.list(two!.id);
    expect(mine).toHaveLength(6);
    expect(theirs).toHaveLength(6);
    const ids = new Set(mine.map((s) => s.id));
    expect(theirs.some((s) => ids.has(s.id))).toBe(false);

    // A person with the same bot in their book but no audience row sees none of them.
    const outsider = await w.user();
    await w.db.insert(contacts).values({
      ownerId: outsider.id,
      linkedUserId: botId("c1"),
      name: "Imogen",
    });
    expect(await w.statuses.list(outsider.id)).toEqual([]);
  });

  it("lists the seeded six the way the prototype shows them", async () => {
    const me = await w.user();
    await w.onboarding.ensureBots();
    await onboard(me);
    const list = await w.statuses.list(me.id);
    expect(list).toHaveLength(6);
    const own = await w.db
      .select({ id: contacts.id, key: contacts.linkedUserId })
      .from(contacts)
      .where(eq(contacts.ownerId, me.id));
    const contactOf = new Map(own.map((row) => [row.key, row.id]));
    const byText = new Map(list.map((s) => [s.text, s]));
    expect(byText.get("Booked the window table.")).toMatchObject({
      ownerId: contactOf.get(botId("c1")),
      color: 1,
      seen: false,
    });
    expect(byText.get("Back from the coast.")).toMatchObject({
      ownerId: contactOf.get(botId("c9")),
      color: 5,
      seen: true,
    });
    expect(list.filter((s) => s.seen)).toHaveLength(1);
    // Oldest first: Hugo's (900 minutes ago) leads, Imogen's pasta (12) is last.
    expect(list.map((s) => s.text)).toEqual([
      "Back from the coast.",
      "New cutting, day one.",
      "Studio is open until six today.",
      "Got the call back. Thank you all.",
      "Booked the window table.",
      "Pasta night, finally.",
    ]);
    expect(SEED_PEOPLE).toHaveLength(14);
  });
});

describe("StatusesService.create", () => {
  it("trims, stores and returns the status, expiring in 24 hours", async () => {
    const me = await w.user();
    const before = Date.now();
    const made = await w.statuses.create(me.id, { text: "  hello there  ", color: 4 });
    const after = Date.now();
    expect(made).toMatchObject({ ownerId: me.id, text: "hello there", color: 4, seen: true });
    expect(made.createdAt).toBeGreaterThanOrEqual(before - 5);
    expect(made.createdAt).toBeLessThanOrEqual(after + 5);
    const [row] = await w.db.select().from(statuses).where(eq(statuses.id, made.id));
    expect(row!.audienceId).toBeNull();
    // The expiry is stored, and is the creation time plus the lifetime to the millisecond.
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(STATUS_TTL_MS);
  });

  it("cuts a long text at 120 characters instead of refusing it", async () => {
    const me = await w.user();
    const made = await w.statuses.create(me.id, { text: "x".repeat(500), color: 0 });
    expect(made.text).toBe("x".repeat(STATUS_TEXT_MAX));
  });

  it("counts characters, not UTF-16 units, so an emoji is never cut in half", async () => {
    const me = await w.user();
    const text = "😀".repeat(STATUS_TEXT_MAX + 5);
    expect(text.length).toBe((STATUS_TEXT_MAX + 5) * 2);
    const made = await w.statuses.create(me.id, { text, color: 0 });
    expect(Array.from(made.text)).toHaveLength(STATUS_TEXT_MAX);
    expect(made.text).toBe("😀".repeat(STATUS_TEXT_MAX));
    // A status of exactly 120 emoji is whole.
    const exact = await w.statuses.create(me.id, { text: "😀".repeat(STATUS_TEXT_MAX), color: 0 });
    expect(Array.from(exact.text)).toHaveLength(STATUS_TEXT_MAX);
  });

  it("trims before cutting, so leading spaces do not use up the limit", async () => {
    const me = await w.user();
    const made = await w.statuses.create(me.id, {
      text: `   ${"y".repeat(STATUS_TEXT_MAX)}`,
      color: 0,
    });
    expect(made.text).toBe("y".repeat(STATUS_TEXT_MAX));
  });

  it("refuses an empty or blank text, and one that is not text", async () => {
    const me = await w.user();
    for (const text of ["", "   ", "\n\t "]) {
      expect(await createCode(me, { text, color: 0 })).toBe("VALIDATION_ERROR");
    }
    expect(await createCode(me, { text: 5, color: 0 })).toBe("VALIDATION_ERROR");
    expect(await w.statuses.list(me.id)).toEqual([]);
  });

  it("accepts the colours 0 to 5 and refuses anything else", async () => {
    const me = await w.user();
    for (const color of [0, 1, 2, 3, 4, 5]) {
      expect((await w.statuses.create(me.id, { text: `c${color}`, color })).color).toBe(color);
    }
    for (const color of [-1, 6, 2.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined]) {
      expect(await createCode(me, { text: "x", color })).toBe("VALIDATION_ERROR");
    }
    expect(await w.statuses.list(me.id)).toHaveLength(6);
  });

  it("names the problem in the error", async () => {
    const me = await w.user();
    const error = await w.statuses.create(me.id, { text: "x", color: 9 }).then(
      () => null,
      (e: unknown) => e as DomainError,
    );
    expect(error?.messages).toEqual(["Color must be a whole number from 0 to 5."]);
  });

  it("lets a contact see it, and is not visible to anyone else", async () => {
    const [me, friend, stranger] = await w.people(3);
    const [meContact] = await w.befriend(friend!, [me!]);
    await w.statuses.create(me!.id, { text: "for friends", color: 1 });
    const [seen] = await w.statuses.list(friend!.id);
    expect(seen).toMatchObject({ text: "for friends", ownerId: meContact, seen: false });
    expect(await w.statuses.list(stranger!.id)).toEqual([]);
  });
});

describe("StatusesService.remove", () => {
  it("deletes my own status, and its views with it", async () => {
    const [me, friend] = await w.people(2);
    await w.befriend(friend!, [me!]);
    const made = await w.statuses.create(me!.id, { text: "bye", color: 0 });
    await w.statuses.markSeen(friend!.id, made.id);
    await w.statuses.remove(me!.id, made.id);
    expect(await w.statuses.list(me!.id)).toEqual([]);
    expect(await w.statuses.list(friend!.id)).toEqual([]);
    const [{ n }] = await w.db
      .select({ n: count() })
      .from(statusViews)
      .where(eq(statusViews.statusId, made.id));
    expect(n).toBe(0);
  });

  it("is 403 for a status I can see but did not write, and leaves it alone", async () => {
    const [me, ann] = await w.people(2);
    await w.befriend(me!, [ann!]);
    const id = await plant(ann!.id, { text: "not mine" });
    expect(await codeOf(() => w.statuses.remove(me!.id, id))).toBe("FORBIDDEN");
    expect(await texts(me!)).toEqual(["not mine"]);
  });

  it("is 404, never 403, for somebody else's status I cannot see", async () => {
    const [me, stranger] = await w.people(2);
    const id = await plant(stranger!.id);
    expect(await codeOf(() => w.statuses.remove(me!.id, id))).toBe("STATUS_NOT_FOUND");
    const rows = await w.db.select().from(statuses).where(eq(statuses.id, id));
    expect(rows).toHaveLength(1);
  });

  it("is 404 for an unknown, malformed, expired or already deleted id", async () => {
    const me = await w.user();
    expect(await codeOf(() => w.statuses.remove(me.id, newId()))).toBe("STATUS_NOT_FOUND");
    for (const bad of ["zzz", "", "1", "not-a-uuid", "../etc"]) {
      expect(await removeCode(me, bad)).toBe("STATUS_NOT_FOUND");
    }
    const old = await plant(me.id, {}, 25 * HOUR);
    expect(await codeOf(() => w.statuses.remove(me.id, old))).toBe("STATUS_NOT_FOUND");
    const made = await w.statuses.create(me.id, { text: "once", color: 0 });
    await w.statuses.remove(me.id, made.id);
    expect(await codeOf(() => w.statuses.remove(me.id, made.id))).toBe("STATUS_NOT_FOUND");
  });

  it("cannot remove the seeded bot's status, which is for the account to see only", async () => {
    const me = await w.user();
    await w.onboarding.ensureBots();
    await onboard(me);
    const [first] = await w.statuses.list(me.id);
    expect(await codeOf(() => w.statuses.remove(me.id, first!.id))).toBe("FORBIDDEN");
    expect(await w.statuses.list(me.id)).toHaveLength(6);
  });

  it("two people removing the same status at once end with one success", async () => {
    const me = await w.user();
    const made = await w.statuses.create(me.id, { text: "race", color: 0 });
    const results = await Promise.all(
      [1, 2, 3].map(() => codeOf(() => w.statuses.remove(me.id, made.id))),
    );
    expect(results.filter((code) => code === undefined)).toHaveLength(1);
    expect(results.filter((code) => code === "STATUS_NOT_FOUND")).toHaveLength(2);
  });
});

describe("StatusesService.markSeen", () => {
  it("marks a contact's status as seen, for me only, and is repeatable", async () => {
    const [me, other, ann] = await w.people(3);
    await w.befriend(me!, [ann!]);
    await w.befriend(other!, [ann!]);
    const id = await plant(ann!.id);
    await w.statuses.markSeen(me!.id, id);
    await w.statuses.markSeen(me!.id, id);
    expect((await w.statuses.list(me!.id))[0]!.seen).toBe(true);
    expect((await w.statuses.list(other!.id))[0]!.seen).toBe(false);
    const rows = await w.db.select().from(statusViews).where(eq(statusViews.statusId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.viewerId).toBe(me!.id);
  });

  it("is a no-op on my own status, and writes no view", async () => {
    const me = await w.user();
    const made = await w.statuses.create(me.id, { text: "own", color: 0 });
    await w.statuses.markSeen(me.id, made.id);
    const rows = await w.db.select().from(statusViews).where(eq(statusViews.statusId, made.id));
    expect(rows).toHaveLength(0);
    expect((await w.statuses.list(me.id))[0]!.seen).toBe(true);
  });

  it("is 404 for a status I cannot see, a malformed id, or an expired one", async () => {
    const [me, stranger, ann] = await w.people(3);
    await w.befriend(me!, [ann!]);
    const hidden = await plant(stranger!.id);
    const expired = await plant(ann!.id, {}, 25 * HOUR);
    for (const id of [hidden, expired, newId(), "zzz", ""]) {
      expect(await seenCode(me!, id)).toBe("STATUS_NOT_FOUND");
    }
    const rows = await w.db.select().from(statusViews).where(eq(statusViews.viewerId, me!.id));
    expect(rows).toHaveLength(0);
  });

  it("is 404 for a bot's status that was made for another account", async () => {
    const [one, two] = await w.people(2);
    await w.onboarding.ensureBots();
    await onboard(one!);
    await onboard(two!);
    const [theirs] = await w.statuses.list(two!.id);
    expect(await codeOf(() => w.statuses.markSeen(one!.id, theirs!.id))).toBe("STATUS_NOT_FOUND");
    expect(await codeOf(() => w.statuses.remove(one!.id, theirs!.id))).toBe("STATUS_NOT_FOUND");
  });

  it("copes with many calls at once", async () => {
    const [me, ann] = await w.people(2);
    await w.befriend(me!, [ann!]);
    const id = await plant(ann!.id);
    await Promise.all(Array.from({ length: 8 }, () => w.statuses.markSeen(me!.id, id)));
    const [{ n }] = await w.db
      .select({ n: count() })
      .from(statusViews)
      .where(eq(statusViews.statusId, id));
    expect(n).toBe(1);
  });
});

describe("StatusesService: keeping viewers apart", () => {
  it("never mixes up two viewers' lists, views and deletes", async () => {
    const [a, b, author] = await w.people(3);
    await w.befriend(a!, [author!]);
    await w.befriend(b!, [author!]);
    const mineA = await w.statuses.create(a!.id, { text: "from A", color: 0 });
    const id = await plant(author!.id, { text: "from author" });

    await w.statuses.markSeen(a!.id, id);
    expect(await codeOf(() => w.statuses.remove(b!.id, mineA.id))).toBe("STATUS_NOT_FOUND");
    expect(await texts(b!)).toEqual(["from author"]);
    expect((await w.statuses.list(b!.id))[0]!.seen).toBe(false);
    expect((await w.statuses.list(a!.id)).find((s) => s.id === id)!.seen).toBe(true);
  });
});
