import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  type ChatDto,
  GROUP_MEMBERS_MAX,
  GROUP_NAME_MAX,
  PIN_LIMIT,
  SYSTEM_SENDER,
} from "@dovetalk/contracts";
import { newId, schema, type UserRow } from "@dovetalk/db";

import { codeOf } from "./support/helpers.js";
import { createWorld, type World } from "./support/world.js";

const { chats, chatMembers, contacts, messages } = schema;

let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

/** A group made by `owner` with some new people, and everything the tests want to know about it. */
async function makeGroup(size = 3, name = "Weekend hikers") {
  const owner = await w.user({ name: "Alex Owner" });
  const people = await w.people(size);
  const contactIds = await w.befriend(owner, people);
  const chat = await w.chats.create(owner.id, { type: "group", name, memberIds: contactIds });
  return { owner, people, contactIds, chat: chat.chat };
}

const membership = async (chatId: string, userId: string) =>
  (
    await w.db
      .select()
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)))
  )[0]!;

const history = async (userId: string, chatId: string) =>
  (await w.messages.page(userId, chatId, { limit: 100 })).items;

describe("ChatsService.create: direct", () => {
  it("opens a chat with a contact, and the other person does not see it yet", async () => {
    const [a, b] = [await w.user({ name: "Ann" }), await w.user({ name: "Bob", hue: 123 })];
    const [contactId] = await w.befriend(a, [b]);

    const { chat, created } = await w.chats.create(a.id, { type: "direct", contactId: contactId! });

    expect(created).toBe(true);
    expect(chat).toMatchObject({
      type: "direct",
      name: null,
      // A direct chat wears the other person's colour, as the viewer sees it.
      hue: 123,
      memberIds: [contactId],
      unread: 0,
      archived: false,
      pinned: false,
      muted: false,
      lastMessage: null,
    });
    expect(await w.chats.list(a.id)).toEqual([chat]);
    expect(await w.chats.list(b.id)).toEqual([]);
  });

  it("uses the contact's own colour over the person's profile colour", async () => {
    const [a, b] = [await w.user(), await w.user({ hue: 100 })];
    const [contactId] = await w.befriend(a, [b]);
    await w.db.update(contacts).set({ hue: 7 }).where(eq(contacts.id, contactId!));
    const { chat } = await w.chats.create(a.id, { type: "direct", contactId: contactId! });
    expect(chat.hue).toBe(7);
  });

  it("returns the same chat the second time, with created false", async () => {
    const [a, b] = [await w.user(), await w.user()];
    const [contactId] = await w.befriend(a, [b]);
    const first = await w.chats.create(a.id, { type: "direct", contactId: contactId! });
    const second = await w.chats.create(a.id, { type: "direct", contactId: contactId! });
    expect(second.created).toBe(false);
    expect(second.chat).toEqual(first.chat);
  });

  it("gives the other person a contact for the opener, so they can name them", async () => {
    const [a, b] = [await w.user({ name: "Ann Opener" }), await w.user()];
    const [contactId] = await w.befriend(a, [b]);
    await w.chats.create(a.id, { type: "direct", contactId: contactId! });
    const theirs = await w.contacts.list(b.id);
    expect(theirs).toMatchObject([{ name: "Ann Opener", saved: false }]);
  });

  it("is one chat when both people open it, and shows it to the second one", async () => {
    const [a, b] = [await w.user(), await w.user()];
    const [aContact] = await w.befriend(a, [b]);
    const [bContact] = await w.befriend(b, [a]);
    const first = await w.chats.create(a.id, { type: "direct", contactId: aContact! });
    const second = await w.chats.create(b.id, { type: "direct", contactId: bContact! });
    expect(second.created).toBe(false);
    expect(second.chat.id).toBe(first.chat.id);
    expect(second.chat.memberIds).toEqual([bContact]);
    expect((await w.chats.list(b.id)).map((c) => c.id)).toEqual([first.chat.id]);
  });

  it("makes exactly one chat when both people open it at the same moment", async () => {
    const [a, b] = [await w.user(), await w.user()];
    const [aContact] = await w.befriend(a, [b]);
    const [bContact] = await w.befriend(b, [a]);
    const calls = Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0
        ? w.chats.create(a.id, { type: "direct", contactId: aContact! })
        : w.chats.create(b.id, { type: "direct", contactId: bContact! }),
    );
    const results = await Promise.all(calls);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.chat.id)).size).toBe(1);
    const rows = await w.db.select().from(chats).where(eq(chats.id, results[0]!.chat.id));
    expect(rows).toHaveLength(1);
    // Both of them have it on their list.
    expect(await w.chats.list(a.id)).toHaveLength(1);
    expect(await w.chats.list(b.id)).toHaveLength(1);
  });

  it("brings a deleted chat back empty, and keeps what was said before out of reach", async () => {
    const [a, b] = [await w.user(), await w.user()];
    const [contactId] = await w.befriend(a, [b]);
    const { chat } = await w.chats.create(a.id, { type: "direct", contactId: contactId! });
    await w.say(chat.id, b.id, "old news");
    await w.chats.remove(a.id, chat.id);

    const again = await w.chats.create(a.id, { type: "direct", contactId: contactId! });
    expect(again.created).toBe(false);
    expect(again.chat).toMatchObject({ id: chat.id, lastMessage: null });
    expect(await history(a.id, chat.id)).toEqual([]);
  });

  it("is CONTACT_NOT_FOUND for an unknown, malformed or somebody else's contact", async () => {
    const [a, b, c] = [await w.user(), await w.user(), await w.user()];
    const [others] = await w.befriend(b, [c]);
    const code = (contactId: string) =>
      codeOf(() => w.chats.create(a.id, { type: "direct", contactId }));
    expect(await code(newId())).toBe("CONTACT_NOT_FOUND");
    expect(await code("nope")).toBe("CONTACT_NOT_FOUND");
    expect(await code(others!)).toBe("CONTACT_NOT_FOUND");
    expect(await w.chats.list(a.id)).toEqual([]);
    expect(await w.chats.list(b.id)).toEqual([]);
  });
});

describe("ChatsService.create: group", () => {
  it("makes a group with a note, the members in the order given, and a colour", async () => {
    const { owner, people, contactIds, chat } = await makeGroup(3, "  Weekend hikers  ");
    expect(chat).toMatchObject({
      type: "group",
      name: "Weekend hikers",
      memberIds: contactIds,
      unread: 0,
      pinned: false,
      archived: false,
      muted: false,
    });
    expect(chat.hue).toBeGreaterThanOrEqual(0);
    expect(chat.hue).toBeLessThan(360);
    expect(chat.lastMessage).toMatchObject({
      kind: "system",
      senderId: SYSTEM_SENDER,
      text: "You created this group",
    });
    const [row] = await w.db.select().from(chats).where(eq(chats.id, chat.id));
    expect(row).toMatchObject({ createdBy: owner.id, lastSeq: 1, directKey: null });
    expect(people).toHaveLength(3);
  });

  it("is on every member's list at once, reading the note from their side", async () => {
    const { people, chat, owner } = await makeGroup(2);
    const theirs = await w.chats.list(people[0]!.id);
    expect(theirs.map((c) => c.id)).toEqual([chat.id]);
    // Their contact for the owner was made for them, under the owner's own name.
    expect(theirs[0]!.lastMessage?.text).toBe("Alex created this group");
    expect(theirs[0]!.memberIds).toHaveLength(2);
    expect(await w.contacts.list(people[0]!.id)).toHaveLength(2);
    expect(owner.id).toBeDefined();
  });

  it("drops duplicates, unknown ids and other people's contacts, then counts who is left", async () => {
    const owner = await w.user();
    const stranger = await w.user();
    const people = await w.people(3);
    const [c1, c2, c3] = await w.befriend(owner, people);
    const [foreign] = await w.befriend(stranger, people.slice(0, 1));
    const make = (memberIds: string[]) =>
      codeOf(() => w.chats.create(owner.id, { type: "group", name: "G", memberIds }));

    expect(await make([c1!, c1!, c1!])).toBe("VALIDATION_ERROR");
    expect(await make([c1!, newId(), "junk"])).toBe("VALIDATION_ERROR");
    expect(await make([c1!, foreign!])).toBe("VALIDATION_ERROR");
    expect(await make([])).toBe("VALIDATION_ERROR");
    expect(await w.chats.list(owner.id)).toEqual([]);

    const ok = await w.chats.create(owner.id, {
      type: "group",
      name: "G",
      memberIds: [c3!, c1!, c1!, newId(), "junk", c2!],
    });
    expect(ok.chat.memberIds).toEqual([c3, c1, c2]);
  });

  it("validates the name null by null", async () => {
    const owner = await w.user();
    const contactIds = await w.befriend(owner, await w.people(2));
    const make = (name: string) =>
      codeOf(() => w.chats.create(owner.id, { type: "group", name, memberIds: contactIds }));
    expect(await make("")).toBe("VALIDATION_ERROR");
    expect(await make("   ")).toBe("VALIDATION_ERROR");
    expect(await make("x".repeat(GROUP_NAME_MAX + 1))).toBe("VALIDATION_ERROR");
    expect(await make("x".repeat(GROUP_NAME_MAX))).toBeUndefined();
  });

  it("refuses more than the limit of other people", async () => {
    const owner = await w.user();
    const people = await w.people(GROUP_MEMBERS_MAX + 1);
    const contactIds = await w.befriend(owner, people);
    const make = (memberIds: string[]) =>
      codeOf(() => w.chats.create(owner.id, { type: "group", name: "Huge", memberIds }));
    expect(await make(contactIds)).toBe("VALIDATION_ERROR");
    expect(await make(contactIds.slice(0, GROUP_MEMBERS_MAX))).toBeUndefined();
  }, 60_000);
});

describe("ChatsService.list", () => {
  it("lists only the viewer's own visible chats, newest chat first", async () => {
    const a = await w.user();
    const [b, c, d] = await w.people(3);
    const [bc, cc, dc] = await w.befriend(a, [b!, c!, d!]);
    const one = await w.chats.create(a.id, { type: "direct", contactId: bc! });
    const two = await w.chats.create(a.id, { type: "direct", contactId: cc! });
    const three = await w.chats.create(a.id, { type: "direct", contactId: dc! });
    // Somebody else's chat, and one the viewer deleted.
    const stranger = await w.user();
    const [sc] = await w.befriend(stranger, [b!]);
    await w.chats.create(stranger.id, { type: "direct", contactId: sc! });
    await w.chats.remove(a.id, two.chat.id);

    expect((await w.chats.list(a.id)).map((x) => x.id)).toEqual([three.chat.id, one.chat.id]);
  });

  it("shows the newest message after the viewer's history starts, with a reply preview", async () => {
    const { owner, people, chat } = await makeGroup(2);
    const first = await w.say(chat.id, people[0]!.id, "first");
    await w.say(chat.id, owner.id, "second", { replyToId: first.id });

    const [view] = await w.chats.list(owner.id);
    expect(view!.lastMessage).toMatchObject({
      text: "second",
      senderId: owner.id,
      replyTo: { id: first.id, text: "first", deleted: false },
    });

    await w.chats.clear(owner.id, chat.id);
    expect((await w.chats.list(owner.id))[0]!.lastMessage).toBeNull();
    // The other members still see it.
    expect((await w.chats.list(people[0]!.id))[0]!.lastMessage?.text).toBe("second");
  });

  it("shows a reply to a message from before the viewer's history as a deleted message", async () => {
    const { owner, people, chat } = await makeGroup(2);
    const old = await w.say(chat.id, people[0]!.id, "before the clear");
    await w.say(chat.id, owner.id, "reply", { replyToId: old.id });
    await w.chats.clear(owner.id, chat.id);
    await w.say(chat.id, owner.id, "later reply", { replyToId: old.id });

    const [view] = await w.chats.list(owner.id);
    expect(view!.lastMessage?.replyTo).toEqual({
      id: old.id,
      senderId: SYSTEM_SENDER,
      kind: "text",
      text: null,
      deleted: true,
    });
  });

  it("names members by the viewer's contacts, in the order they joined", async () => {
    const { people, contactIds, chat } = await makeGroup(3);
    const mine = await w.chats.list(people[1]!.id);
    // From the second member's side: the owner and the two others, none of them the viewer.
    const theirContacts = await w.contacts.list(people[1]!.id);
    const byUser = new Map(theirContacts.map((c) => [c.name, c.id]));
    expect(mine[0]!.memberIds).toHaveLength(3);
    expect(mine[0]!.memberIds).toContain(byUser.get("Alex Owner"));
    expect(mine[0]!.memberIds).not.toContain(contactIds[1]);
    expect(chat.id).toBe(mine[0]!.id);
  });

  it("runs the same few queries whether the viewer has 2 chats or 30", async () => {
    const small = await w.user();
    const large = await w.user();
    const make = async (viewer: UserRow, n: number) => {
      const people = await w.people(n);
      const contactIds = await w.befriend(viewer, people);
      for (const contactId of contactIds) {
        const { chat } = await w.chats.create(viewer.id, { type: "direct", contactId });
        await w.say(chat.id, viewer.id, "hi");
      }
    };
    await make(small, 2);
    await make(large, 30);

    const spy = vi.spyOn(w.handle.pool, "query");
    const count = async (viewer: UserRow) => {
      spy.mockClear();
      const result = await w.chats.list(viewer.id);
      return { queries: spy.mock.calls.length, chats: result.length };
    };
    const a = await count(small);
    const b = await count(large);
    spy.mockRestore();

    expect(a.chats).toBe(2);
    expect(b.chats).toBe(30);
    // Three for the list, then one for the reactions on the last messages. No message here has a
    // file, so the files query does not run: at most five, never one more per chat.
    expect(a.queries).toBe(4);
    expect(b.queries).toBe(a.queries);
  });
});

describe("ChatsService.update: flags and the pin limit", () => {
  async function directChats(n: number) {
    const viewer = await w.user();
    const people = await w.people(n);
    const contactIds = await w.befriend(viewer, people);
    const made: ChatDto[] = [];
    for (const contactId of contactIds) {
      made.push((await w.chats.create(viewer.id, { type: "direct", contactId })).chat);
    }
    return { viewer, people, chats: made };
  }

  it("changes the flags that were sent and nobody else's", async () => {
    const { owner, people, chat } = await makeGroup(2);
    const updated = await w.chats.update(owner.id, chat.id, { archived: true, muted: true });
    expect(updated).toMatchObject({ archived: true, muted: true, pinned: false });
    const theirs = (await w.chats.list(people[0]!.id))[0]!;
    expect(theirs).toMatchObject({ archived: false, muted: false, pinned: false });

    const next = await w.chats.update(owner.id, chat.id, { pinned: true });
    expect(next).toMatchObject({ archived: true, muted: true, pinned: true });
    expect(await w.chats.update(owner.id, chat.id, {})).toEqual(next);
  });

  it("allows PIN_LIMIT pins, refuses the next, and lets a pinned one be pinned again", async () => {
    const { viewer, chats: made } = await directChats(PIN_LIMIT + 1);
    for (const chat of made.slice(0, PIN_LIMIT)) {
      await w.chats.update(viewer.id, chat.id, { pinned: true });
    }
    const extra = made[PIN_LIMIT]!;
    expect(await codeOf(() => w.chats.update(viewer.id, extra.id, { pinned: true }))).toBe(
      "PIN_LIMIT",
    );
    expect((await w.chats.list(viewer.id)).filter((c) => c.pinned)).toHaveLength(PIN_LIMIT);

    await expect(w.chats.update(viewer.id, made[0]!.id, { pinned: true })).resolves.toBeDefined();
    await w.chats.update(viewer.id, made[0]!.id, { pinned: false });
    await expect(w.chats.update(viewer.id, extra.id, { pinned: true })).resolves.toMatchObject({
      pinned: true,
    });
  });

  it("counts an archived pinned chat, and does not count a deleted one", async () => {
    const { viewer, chats: made } = await directChats(PIN_LIMIT + 1);
    for (const chat of made.slice(0, PIN_LIMIT)) {
      await w.chats.update(viewer.id, chat.id, { pinned: true });
    }
    await w.chats.update(viewer.id, made[0]!.id, { archived: true });
    const extra = made[PIN_LIMIT]!;
    expect(await codeOf(() => w.chats.update(viewer.id, extra.id, { pinned: true }))).toBe(
      "PIN_LIMIT",
    );

    // Deleting a pinned chat unpins it and takes it out of the count.
    await w.chats.remove(viewer.id, made[1]!.id);
    await expect(w.chats.update(viewer.id, extra.id, { pinned: true })).resolves.toBeDefined();
  });

  it("lets only PIN_LIMIT of many simultaneous pins through", async () => {
    const { viewer, chats: made } = await directChats(PIN_LIMIT + 4);
    const results = await Promise.allSettled(
      made.map((chat) => w.chats.update(viewer.id, chat.id, { pinned: true })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(PIN_LIMIT);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toMatchObject({ code: "PIN_LIMIT" });
    }
    expect((await w.chats.list(viewer.id)).filter((c) => c.pinned)).toHaveLength(PIN_LIMIT);
  });

  it("does not let one person's pins count against another's", async () => {
    const { viewer, chats: made } = await directChats(PIN_LIMIT);
    const other = await w.user();
    for (const chat of made) {
      await w.chats.update(viewer.id, chat.id, { pinned: true });
    }
    const contactIds = await w.befriend(other, await w.people(1));
    const { chat } = await w.chats.create(other.id, { type: "direct", contactId: contactIds[0]! });
    await expect(w.chats.update(other.id, chat.id, { pinned: true })).resolves.toBeDefined();
  });
});

describe("ChatsService.update: renaming", () => {
  it("lets any active member rename, with a note that reads from each side", async () => {
    const { owner, people, chat } = await makeGroup(2);
    const renamed = await w.chats.update(people[0]!.id, chat.id, { name: "  Trail crew " });
    expect(renamed.name).toBe("Trail crew");
    expect(renamed.lastMessage?.text).toBe("You renamed the group to “Trail crew”");
    const ownerView = (await w.chats.list(owner.id))[0]!;
    expect(ownerView.name).toBe("Trail crew");
    expect(ownerView.lastMessage?.text).toMatch(/^Person\d+ renamed the group to “Trail crew”$/u);
  });

  it("is a no-op, with no note, when the trimmed name is unchanged", async () => {
    const { owner, chat } = await makeGroup(2, "Same");
    const before = await w.db.select().from(chats).where(eq(chats.id, chat.id));
    await w.chats.update(owner.id, chat.id, { name: "  Same  " });
    const after = await w.db.select().from(chats).where(eq(chats.id, chat.id));
    expect(after[0]!.lastSeq).toBe(before[0]!.lastSeq);
  });

  it("refuses an empty or long name, and a name on a direct chat", async () => {
    const { owner, chat } = await makeGroup(2);
    const code = (name: string) => codeOf(() => w.chats.update(owner.id, chat.id, { name }));
    expect(await code("")).toBe("VALIDATION_ERROR");
    expect(await code("  ")).toBe("VALIDATION_ERROR");
    expect(await code("x".repeat(GROUP_NAME_MAX + 1))).toBe("VALIDATION_ERROR");

    const [a, b] = [await w.user(), await w.user()];
    const [contactId] = await w.befriend(a, [b]);
    const { chat: direct } = await w.chats.create(a.id, { type: "direct", contactId: contactId! });
    expect(await codeOf(() => w.chats.update(a.id, direct.id, { name: "Nope" }))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("does not change anything when part of the patch is refused", async () => {
    const { owner, chat } = await makeGroup(2);
    await codeOf(() => w.chats.update(owner.id, chat.id, { archived: true, name: "" }));
    expect((await w.chats.list(owner.id))[0]).toMatchObject({ archived: false });
  });
});

describe("ChatsService.update, remove, markRead and clear: whose chat it is", () => {
  it("answers 404, never 403, for somebody else's chat, an unknown id and a malformed id", async () => {
    const { chat } = await makeGroup(2);
    const outsider = await w.user();
    const attempts = [chat.id, newId(), "not-a-uuid", ""];
    const attemptsOn = (id: string) => [
      () => w.chats.update(outsider.id, id, { archived: true }),
      () => w.chats.remove(outsider.id, id),
      () => w.chats.markRead(outsider.id, id),
      () => w.chats.clear(outsider.id, id),
      () => w.chats.addMembers(outsider.id, id, []),
      () => w.chats.removeMember(outsider.id, id, newId()),
      () => w.messages.page(outsider.id, id),
    ];
    for (const id of attempts) {
      for (const run of attemptsOn(id)) {
        expect(await codeOf(run)).toBe("CHAT_NOT_FOUND");
      }
    }
  });
});

describe("ChatsService.remove, markRead and clear", () => {
  it("deletes the chat for the viewer only, and resets what was theirs", async () => {
    const { owner, people, chat } = await makeGroup(2);
    await w.chats.update(owner.id, chat.id, { pinned: true, archived: true, muted: true });
    await w.say(chat.id, people[0]!.id, "hello");
    await w.db
      .update(chatMembers)
      .set({ unreadCount: 4 })
      .where(and(eq(chatMembers.chatId, chat.id), eq(chatMembers.userId, owner.id)));

    await w.chats.remove(owner.id, chat.id);

    expect(await w.chats.list(owner.id)).toEqual([]);
    expect(await codeOf(() => w.messages.page(owner.id, chat.id))).toBe("CHAT_NOT_FOUND");
    expect(await membership(chat.id, owner.id)).toMatchObject({
      clearedBeforeSeq: 2,
      unreadCount: 0,
      pinned: false,
      archived: false,
      muted: false,
    });
    expect(await w.chats.list(people[0]!.id)).toHaveLength(1);
    // The second delete finds nothing.
    expect(await codeOf(() => w.chats.remove(owner.id, chat.id))).toBe("CHAT_NOT_FOUND");
  });

  it("markRead zeroes only the viewer's unread count, and is harmless when it is already zero", async () => {
    const { owner, people, chat } = await makeGroup(2);
    await w.db.update(chatMembers).set({ unreadCount: 3 }).where(eq(chatMembers.chatId, chat.id));
    await w.chats.markRead(owner.id, chat.id);
    await w.chats.markRead(owner.id, chat.id);
    expect((await w.chats.list(owner.id))[0]!.unread).toBe(0);
    expect((await w.chats.list(people[0]!.id))[0]!.unread).toBe(3);
  });

  it("clear empties the chat for the viewer and keeps their flags and the others' history", async () => {
    const { owner, people, chat } = await makeGroup(2);
    await w.say(chat.id, people[0]!.id, "one");
    await w.say(chat.id, people[1]!.id, "two");
    await w.chats.update(owner.id, chat.id, { pinned: true });
    await w.db
      .update(chatMembers)
      .set({ unreadCount: 2 })
      .where(and(eq(chatMembers.chatId, chat.id), eq(chatMembers.userId, owner.id)));

    await w.chats.clear(owner.id, chat.id);

    expect(await history(owner.id, chat.id)).toEqual([]);
    expect((await w.chats.list(owner.id))[0]).toMatchObject({
      pinned: true,
      unread: 0,
      lastMessage: null,
    });
    expect((await history(people[0]!.id, chat.id)).map((m) => m.text)).toContain("two");

    // New messages after the clear are visible again.
    await w.say(chat.id, people[0]!.id, "three");
    expect((await history(owner.id, chat.id)).map((m) => m.text)).toEqual(["three"]);
  });
});

describe("ChatsService.addMembers", () => {
  it("adds people, with a note, and shows them the chat from that note on", async () => {
    const { owner, chat } = await makeGroup(2);
    await w.say(chat.id, owner.id, "before the newcomer");
    const [newcomer] = await w.people(1);
    const [contactId] = await w.befriend(owner, [newcomer!]);

    const updated = await w.chats.addMembers(owner.id, chat.id, [contactId!]);

    expect(updated.memberIds).toHaveLength(3);
    expect(updated.memberIds).toContain(contactId);
    expect(updated.lastMessage?.text).toBe(`You added ${newcomer!.name.split(" ")[0]}`);
    const theirs = await history(newcomer!.id, chat.id);
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({ kind: "system", text: "Alex added you" });
    // They can name everyone, and everyone can name them.
    expect(await w.contacts.list(newcomer!.id)).toHaveLength(3);
  });

  it("says 'you and X' to a newcomer added together with somebody", async () => {
    const { owner, chat } = await makeGroup(2);
    const people = await w.people(2);
    const contactIds = await w.befriend(owner, people);
    await w.chats.addMembers(owner.id, chat.id, contactIds);
    const theirs = await history(people[0]!.id, chat.id);
    expect(theirs.at(-1)!.text).toBe("Alex added you and Person1");
  });

  it("lets any member add, not only the creator", async () => {
    const { people, chat } = await makeGroup(2);
    const member = people[0]!;
    const [newcomer] = await w.people(1);
    const [contactId] = await w.befriend(member, [newcomer!]);
    const updated = await w.chats.addMembers(member.id, chat.id, [contactId!]);
    expect(updated.memberIds).toHaveLength(3);
  });

  it("does nothing, with no note, for people who are already in", async () => {
    const { owner, chat, contactIds } = await makeGroup(2);
    const before = await w.db.select().from(chats).where(eq(chats.id, chat.id));
    const updated = await w.chats.addMembers(owner.id, chat.id, [...contactIds, newId(), "junk"]);
    expect(updated).toEqual((await w.chats.list(owner.id))[0]);
    const after = await w.db.select().from(chats).where(eq(chats.id, chat.id));
    expect(after[0]!.lastSeq).toBe(before[0]!.lastSeq);
  });

  it("only works on groups", async () => {
    const [a, b] = [await w.user(), await w.user()];
    const [contactId] = await w.befriend(a, [b]);
    const { chat } = await w.chats.create(a.id, { type: "direct", contactId: contactId! });
    expect(await codeOf(() => w.chats.addMembers(a.id, chat.id, [contactId!]))).toBe(
      "VALIDATION_ERROR",
    );
  });

  it("refuses to go over the limit, and lets a group fill up exactly", async () => {
    const { owner, chat } = await makeGroup(2);
    const people = await w.people(GROUP_MEMBERS_MAX);
    const contactIds = await w.befriend(owner, people);
    // 2 are in already, so there is room for GROUP_MEMBERS_MAX - 2 more.
    expect(await codeOf(() => w.chats.addMembers(owner.id, chat.id, contactIds))).toBe(
      "VALIDATION_ERROR",
    );
    await expect(
      w.chats.addMembers(owner.id, chat.id, contactIds.slice(0, GROUP_MEMBERS_MAX - 2)),
    ).resolves.toBeDefined();
    expect(await codeOf(() => w.chats.addMembers(owner.id, chat.id, contactIds.slice(-1)))).toBe(
      "VALIDATION_ERROR",
    );
  }, 60_000);
});

describe("ChatsService.removeMember", () => {
  it("removes a member: they lose the chat at once and the others see a note", async () => {
    const { owner, people, contactIds, chat } = await makeGroup(3);
    await w.chats.update(people[0]!.id, chat.id, { pinned: true });

    const updated = await w.chats.removeMember(owner.id, chat.id, contactIds[0]!);

    expect(updated.memberIds).toEqual([contactIds[1], contactIds[2]]);
    expect(updated.lastMessage?.text).toBe("You removed Person0");
    expect(await w.chats.list(people[0]!.id)).toEqual([]);
    expect(await codeOf(() => w.messages.page(people[0]!.id, chat.id))).toBe("CHAT_NOT_FOUND");
    expect(await membership(chat.id, people[0]!.id)).toMatchObject({
      pinned: false,
      unreadCount: 0,
    });
    expect((await membership(chat.id, people[0]!.id)).leftAt).toBeInstanceOf(Date);
    expect((await w.chats.list(people[1]!.id))[0]!.lastMessage?.text).toBe("Alex removed Person0");
  });

  it("can add them back, to a fresh history", async () => {
    const { owner, people, contactIds, chat } = await makeGroup(3);
    await w.chats.removeMember(owner.id, chat.id, contactIds[0]!);
    await w.say(chat.id, owner.id, "while you were away");
    await w.chats.addMembers(owner.id, chat.id, [contactIds[0]!]);
    const theirs = await history(people[0]!.id, chat.id);
    expect(theirs.map((m) => m.text)).toEqual(["Alex added you"]);
    expect((await w.chats.list(owner.id))[0]!.memberIds).toHaveLength(3);
  });

  it("checks in a fixed order: creator, group, member, minimum", async () => {
    const { owner, people, contactIds, chat } = await makeGroup(3);
    const member = people[0]!;
    const memberContactForOwner = contactIds[1]!;
    const removeAs = (viewer: string, id: string, contactId: string) =>
      codeOf(() => w.chats.removeMember(viewer, id, contactId));

    // 404 before everything: the chat is not the viewer's.
    expect(await removeAs((await w.user()).id, chat.id, memberContactForOwner)).toBe(
      "CHAT_NOT_FOUND",
    );
    // 403: a member who did not create the group, even with a contact that does not exist.
    expect(await removeAs(member.id, chat.id, newId())).toBe("FORBIDDEN");
    // 422: a direct chat is not a group, checked before the creator.
    const [a, b] = [await w.user(), await w.user()];
    const [contactId] = await w.befriend(a, [b]);
    const { chat: direct } = await w.chats.create(a.id, { type: "direct", contactId: contactId! });
    expect(await removeAs(a.id, direct.id, contactId!)).toBe("VALIDATION_ERROR");
    // 404 MEMBER_NOT_FOUND: unknown, malformed, somebody else's contact, or not in this group.
    expect(await removeAs(owner.id, chat.id, newId())).toBe("MEMBER_NOT_FOUND");
    expect(await removeAs(owner.id, chat.id, "junk")).toBe("MEMBER_NOT_FOUND");
    const [outsider] = await w.people(1);
    const [outsiderContact] = await w.befriend(owner, [outsider!]);
    expect(await removeAs(owner.id, chat.id, outsiderContact!)).toBe("MEMBER_NOT_FOUND");
    // 422: removing would leave fewer than two other members.
    await w.chats.removeMember(owner.id, chat.id, contactIds[0]!);
    expect(await removeAs(owner.id, chat.id, contactIds[1]!)).toBe("VALIDATION_ERROR");
    expect((await w.chats.list(owner.id))[0]!.memberIds).toEqual([contactIds[1], contactIds[2]]);
  });

  it("is MEMBER_NOT_FOUND for somebody who was already removed", async () => {
    const { owner, contactIds, chat } = await makeGroup(4);
    await w.chats.removeMember(owner.id, chat.id, contactIds[0]!);
    expect(await codeOf(() => w.chats.removeMember(owner.id, chat.id, contactIds[0]!))).toBe(
      "MEMBER_NOT_FOUND",
    );
  });

  it("cannot take a group below two others when two removals race", async () => {
    const { owner, contactIds, chat } = await makeGroup(3);
    const results = await Promise.allSettled([
      w.chats.removeMember(owner.id, chat.id, contactIds[0]!),
      w.chats.removeMember(owner.id, chat.id, contactIds[1]!),
      w.chats.removeMember(owner.id, chat.id, contactIds[2]!),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await w.chats.list(owner.id))[0]!.memberIds).toHaveLength(2);
  });

  it("lets nobody remove people from a group whose creator has been deleted", async () => {
    const { owner, people, contactIds, chat } = await makeGroup(3);
    await w.db.update(chats).set({ createdBy: null }).where(eq(chats.id, chat.id));
    expect(await codeOf(() => w.chats.removeMember(owner.id, chat.id, contactIds[0]!))).toBe(
      "FORBIDDEN",
    );
    expect(await codeOf(() => w.chats.removeMember(people[0]!.id, chat.id, newId()))).toBe(
      "FORBIDDEN",
    );
  });
});

describe("what the viewer cannot see never leaks", () => {
  it("does not show another viewer's contact ids or names for the same group", async () => {
    const { owner, people, contactIds } = await makeGroup(2);
    const ownerView = (await w.chats.list(owner.id))[0]!;
    const memberView = (await w.chats.list(people[0]!.id))[0]!;
    expect(ownerView.memberIds).toEqual(contactIds);
    expect(memberView.memberIds.some((id) => contactIds.includes(id))).toBe(false);
    const stored = await w.db.select().from(messages).where(eq(messages.chatId, ownerView.id));
    expect(stored[0]!.text).toBeNull();
    expect(stored[0]!.senderId).toBeNull();
  });
});
