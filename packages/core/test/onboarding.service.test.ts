import { and, count, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { ChatDto, ContactDto } from "@dovetalk/contracts";
import { schema, type UserRow } from "@dovetalk/db";
import { byCodeUnit } from "@dovetalk/testkit";

import { botId, makeBars, OnboardingService, SEED_PEOPLE } from "../src/index.js";
import { codeOf } from "./support/helpers.js";
import { createWorld, type World } from "./support/world.js";

const { users, contacts, chats, chatMembers, messages, messageReactions, statuses, statusViews } =
  schema;

const MIN = 60_000;
let w: World;
beforeAll(async () => {
  w = await createWorld();
});
afterAll(() => w.close());

/** A new account, onboarded the way registration does it: bots first, then one transaction. */
async function onboarded(now = Date.now(), name = "Alex Rivera") {
  const user = await w.user({ name });
  await w.onboarding.ensureBots();
  await w.db.transaction((tx) => w.onboarding.onboard(tx, user.id, now));
  return user;
}

/** Everything a viewer sees, with direct chats named after the person in them. */
async function view(user: UserRow) {
  const [contactList, chatList] = await Promise.all([
    w.contacts.list(user.id),
    w.chats.list(user.id),
  ]);
  const nameOf = new Map(contactList.map((c) => [c.id, c.name]));
  const byName = new Map<string, ChatDto>();
  for (const chat of chatList) {
    byName.set(chat.type === "group" ? chat.name! : nameOf.get(chat.memberIds[0]!)!, chat);
  }
  const contactByName = new Map<string, ContactDto>(contactList.map((c) => [c.name, c]));
  return { contactList, chatList, byName, contactByName };
}

const rowsFor = async (userId: string) => ({
  contacts: (
    await w.db.select({ n: count() }).from(contacts).where(eq(contacts.ownerId, userId))
  )[0]!.n,
  memberships: (
    await w.db.select({ n: count() }).from(chatMembers).where(eq(chatMembers.userId, userId))
  )[0]!.n,
});

/** The reactions in an account's chats, the statuses made for it, and the ones it has seen. */
const extrasFor = async (userId: string) => ({
  reactions: (
    await w.db
      .select({ n: count() })
      .from(messageReactions)
      .innerJoin(messages, eq(messages.id, messageReactions.messageId))
      .innerJoin(
        chatMembers,
        and(eq(chatMembers.chatId, messages.chatId), eq(chatMembers.userId, userId)),
      )
  )[0]!.n,
  statuses: (
    await w.db.select({ n: count() }).from(statuses).where(eq(statuses.audienceId, userId))
  )[0]!.n,
  views: (
    await w.db.select({ n: count() }).from(statusViews).where(eq(statusViews.viewerId, userId))
  )[0]!.n,
});

describe("OnboardingService.onboard: what a new account sees", () => {
  const NOW = Date.now();
  let user: UserRow;
  let v: Awaited<ReturnType<typeof view>>;
  beforeAll(async () => {
    user = await onboarded(NOW);
    v = await view(user);
  });

  it("lists the 14 bots as saved contacts, in order, with their number and profile", () => {
    expect(v.contactList).toHaveLength(14);
    v.contactList.forEach((contact, i) => {
      const person = SEED_PEOPLE[i]!;
      expect(contact).toMatchObject({
        name: person.name,
        phone: person.phone,
        about: person.about,
        hue: person.hue,
        online: person.online,
        blocked: false,
        saved: true,
        avatarUrl: null,
      });
    });
  });

  it("lists 11 chats with the unread counts, archive and pin flags of the prototype", () => {
    expect(v.chatList).toHaveLength(11);
    const flags = (name: string) => {
      const chat = v.byName.get(name)!;
      return [chat.unread, chat.archived, chat.pinned, chat.muted];
    };
    expect(flags("Imogen Varley")).toEqual([2, false, false, false]);
    expect(flags("Priya Anand")).toEqual([1, false, false, false]);
    expect(flags("Weekend hikers")).toEqual([3, false, false, false]);
    expect(flags("Studio crew")).toEqual([0, false, true, false]);
    expect(flags("Wren Castellano")).toEqual([0, true, false, false]);
    expect(flags("Hugo Lindqvist")).toEqual([0, true, false, false]);
    for (const name of [
      "Tobias Kellner",
      "Marcus Oyelaran",
      "Linnea Hoff",
      "Dario Bellamy",
      "Sana Qureshi",
    ]) {
      expect(flags(name)).toEqual([0, false, false, false]);
    }
    expect(v.chatList.filter((c) => c.archived)).toHaveLength(2);
    expect(v.chatList.filter((c) => c.pinned).map((c) => c.name)).toEqual(["Studio crew"]);
    expect(v.chatList.filter((c) => c.type === "group")).toHaveLength(2);
  });

  it("names the people in each chat by this viewer's contact ids, in the group's order", () => {
    const idOf = (name: string) => v.contactByName.get(name)!.id;
    expect(v.byName.get("Weekend hikers")).toMatchObject({
      hue: 160,
      memberIds: ["Imogen Varley", "Priya Anand", "Linnea Hoff", "Amara Okafor"].map(idOf),
    });
    expect(v.byName.get("Studio crew")).toMatchObject({
      hue: 20,
      memberIds: ["Tobias Kellner", "Marcus Oyelaran", "Dario Bellamy"].map(idOf),
    });
    // A direct chat has no name and takes the colour of the person in it.
    const imogen = v.byName.get("Imogen Varley")!;
    expect(imogen).toMatchObject({
      type: "direct",
      name: null,
      hue: 262,
      memberIds: [idOf("Imogen Varley")],
    });
  });

  it("shows the newest message of every chat as its last message", () => {
    const newest: Record<string, [string | null, number]> = {
      "Imogen Varley": ["Save me a seat and order the burrata.", 10],
      "Tobias Kellner": ["Saw them. Fixing both this afternoon.", 40],
      "Priya Anand": ["Definitely. I will send options tomorrow.", 180],
      "Marcus Oyelaran": ["Noon it is. I will grab us a spot.", 1800],
      "Linnea Hoff": ["Want a cutting? It has grown a lot.", 2900],
      "Dario Bellamy": ["Ten works. I will bring the camera.", 19_500],
      "Sana Qureshi": ["No problem at all. Get some rest.", 7200],
      "Wren Castellano": ["Got it, paying on the first.", 19_900],
      "Hugo Lindqvist": ["Amazing, looking through them now.", 29_900],
      "Weekend hikers": ["I will bring a thermos of tea.", 88],
      "Studio crew": ["I can present the options on Thursday.", 290],
    };
    for (const [name, [text, ago]] of Object.entries(newest)) {
      const last = v.byName.get(name)!.lastMessage;
      expect(last?.text, name).toBe(text);
      expect(last?.createdAt, name).toBe(NOW - ago * MIN);
    }
  });

  it("pages Imogen's long history from the newest back to the start", async () => {
    const chat = v.byName.get("Imogen Varley")!;
    const seen: string[] = [];
    const sizes: number[] = [];
    let before: string | null = null;
    do {
      const page = await w.messages.page(user.id, chat.id, { limit: 25, before });
      sizes.push(page.items.length);
      // Each page is oldest first, and older pages are prepended.
      seen.unshift(...page.items.map((m) => m.id));
      before = page.nextCursor;
    } while (before);

    expect(sizes).toEqual([25, 25, 25, 2]);
    expect(seen).toHaveLength(77);
    expect(new Set(seen).size).toBe(77);

    const all = (await w.messages.page(user.id, chat.id, { limit: 100 })).items;
    expect(all.map((m) => m.id)).toEqual(seen);
    for (let i = 1; i < all.length; i += 1) {
      expect(all[i]!.createdAt).toBeGreaterThanOrEqual(all[i - 1]!.createdAt);
    }
    expect(all.at(-1)!.text).toBe("Save me a seat and order the burrata.");
    expect(all.at(-3)!.text).toBe("Great, see you there.");
    // The viewer's own messages say so, and Imogen's carry the viewer's contact id for her.
    expect(all.at(-3)!.senderId).toBe(user.id);
    expect(all.at(-1)!.senderId).toBe(v.contactByName.get("Imogen Varley")!.id);
  });

  it("points a reply at the original, whose preview the reader gets", async () => {
    const chat = v.byName.get("Tobias Kellner")!;
    const { items } = await w.messages.page(user.id, chat.id);
    expect(items).toHaveLength(5);
    expect(items.slice(0, 4).every((m) => m.replyTo === null)).toBe(true);
    expect(items[4]!.replyTo).toMatchObject({
      id: items[3]!.id,
      senderId: user.id,
      text: "Will do. I added two comments on page 3.",
      deleted: false,
    });
  });

  it("stores the voice message with its bars", async () => {
    const chat = v.byName.get("Priya Anand")!;
    const { items } = await w.messages.page(user.id, chat.id);
    const voice = items.find((m) => m.kind === "voice")!;
    expect(voice).toMatchObject({ duration: 14, text: null });
    // 77 + 5 messages in the chats before this one, and it is this chat's third.
    expect(voice.bars).toEqual(makeBars((77 + 5 + 3) * 7919));
  });

  it("tells the hikers' creation note in the viewer's words, and shows the seeded reactions", async () => {
    const chat = v.byName.get("Weekend hikers")!;
    const { items } = await w.messages.page(user.id, chat.id, { limit: 100 });
    // 47 messages are more than the 25-message default, but this page asked for up to 100.
    expect(items).toHaveLength(47);
    expect(items[0]).toMatchObject({
      kind: "system",
      senderId: "system",
      text: "Imogen created this group",
    });
    const hike = items.find((m) => m.text === "Saturday hike, who is in?")!;
    expect(hike.senderId).toBe(v.contactByName.get("Imogen Varley")!.id);

    // The reactions are written as contact ids of the viewer: Imogen and Priya cheered "In!".
    const imogen = v.contactByName.get("Imogen Varley")!;
    const priya = v.contactByName.get("Priya Anand")!;
    const inMessage = items.find((m) => m.text === "In!")!;
    expect(inMessage.reactions).toEqual({ "🎉": [imogen.id, priya.id] });

    const withImogen = await w.messages.page(user.id, v.byName.get("Imogen Varley")!.id, {
      limit: 100,
    });
    const seeYou = withImogen.items.find((m) => m.text === "Great, see you there.")!;
    expect(seeYou.reactions).toEqual({ "❤️": [imogen.id] });

    // Those are the only three reactions anywhere.
    const reacted: string[] = [];
    for (const c of v.chatList) {
      const page = await w.messages.page(user.id, c.id, { limit: 100 });
      for (const m of page.items) {
        reacted.push(...Object.values(m.reactions).flatMap((who) => who.map(() => m.id)));
      }
    }
    expect(reacted.sort(byCodeUnit)).toEqual(
      [inMessage.id, inMessage.id, seeYou.id].sort(byCodeUnit),
    );
  });

  it("lets the viewer add people to the hikers, which a bot made, but not remove anyone", async () => {
    const fresh = await onboarded();
    const f = await view(fresh);
    const hikers = f.byName.get("Weekend hikers")!;
    const sana = f.contactByName.get("Sana Qureshi")!;

    expect(
      await codeOf(() => w.chats.removeMember(fresh.id, hikers.id, hikers.memberIds[0]!)),
    ).toBe("FORBIDDEN");
    const updated = await w.chats.addMembers(fresh.id, hikers.id, [sana.id]);
    expect(updated.memberIds).toHaveLength(5);
    expect(updated.memberIds).toContain(sana.id);
  });

  it("lets the viewer remove people from the studio crew, which they made", async () => {
    const fresh = await onboarded();
    const f = await view(fresh);
    const studio = f.byName.get("Studio crew")!;
    const updated = await w.chats.removeMember(fresh.id, studio.id, studio.memberIds[2]!);
    expect(updated.memberIds).toEqual(studio.memberIds.slice(0, 2));
  });

  it("works with the rest of the chat rules: pin limit, read, clear", async () => {
    const fresh = await onboarded();
    const f = await view(fresh);
    const pin = (name: string) =>
      w.chats.update(fresh.id, f.byName.get(name)!.id, { pinned: true });
    await pin("Imogen Varley");
    await pin("Priya Anand");
    // The studio crew was already pinned, so this is the fourth.
    expect(await codeOf(() => pin("Tobias Kellner"))).toBe("PIN_LIMIT");

    await w.chats.markRead(fresh.id, f.byName.get("Weekend hikers")!.id);
    await w.chats.clear(fresh.id, f.byName.get("Studio crew")!.id);
    const after = await view(fresh);
    expect(after.byName.get("Weekend hikers")!.unread).toBe(0);
    expect(after.byName.get("Studio crew")!.lastMessage).toBeNull();
  });

  it("writes 3 reactions, 6 statuses and the one status the account has seen", async () => {
    expect(await extrasFor(user.id)).toEqual({ reactions: 3, statuses: 6, views: 1 });
    const mine = await w.db.select().from(statuses).where(eq(statuses.audienceId, user.id));
    // Every note is a bot's, made for this account, and lives for the lifetime in the contract.
    for (const row of mine) {
      expect(row.audienceId).toBe(user.id);
      expect(SEED_PEOPLE.some((p) => botId(p.key) === row.ownerId)).toBe(true);
      expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(24 * 60 * MIN);
    }
  });

  it("keeps the same few queries for the whole chat list", async () => {
    const spy = vi.spyOn(w.handle.pool, "query");
    spy.mockClear();
    const list = await w.chats.list(user.id);
    const queries = spy.mock.calls.length;
    spy.mockRestore();
    expect(list).toHaveLength(11);
    // Three for the list and one for the reactions; the seeded messages have no files.
    expect(queries).toBe(4);
  });
});

describe("OnboardingService: shared bots and separate accounts", () => {
  it("gives two accounts the same 14 bot rows and nothing of each other's", async () => {
    const a = await onboarded(Date.now(), "Ann");
    const b = await onboarded(Date.now(), "Bob");

    const bots = await w.db.select().from(users).where(eq(users.isBot, true));
    const seedBots = bots.filter((u) => SEED_PEOPLE.some((p) => botId(p.key) === u.id));
    expect(seedBots).toHaveLength(14);
    for (const bot of seedBots) {
      expect(bot).toMatchObject({ email: null, passwordHash: null, phone: null, isGuest: false });
    }

    const [va, vb] = [await view(a), await view(b)];
    // Same people, different ids for them: a contact id means something to one viewer only.
    expect(va.contactList.map((c) => c.name)).toEqual(vb.contactList.map((c) => c.name));
    const idsA = new Set([...va.contactList.map((c) => c.id), ...va.chatList.map((c) => c.id)]);
    for (const id of [...vb.contactList.map((c) => c.id), ...vb.chatList.map((c) => c.id)]) {
      expect(idsA.has(id)).toBe(false);
    }
    // Each has their own copy of every chat, and cannot open the other's.
    const chatOfA = va.byName.get("Imogen Varley")!;
    expect(await codeOf(() => w.messages.page(b.id, chatOfA.id))).toBe("CHAT_NOT_FOUND");

    // A bot's direct chat is one per owner: the key includes the owner.
    const keys = await w.db
      .select({ key: chats.directKey })
      .from(chats)
      .where(eq(chats.type, "direct"));
    expect(new Set(keys.map((k) => k.key)).size).toBe(keys.length);

    // Each account has its own copies of the statuses and the reactions, none shared.
    expect(await extrasFor(a.id)).toEqual({ reactions: 3, statuses: 6, views: 1 });
    expect(await extrasFor(b.id)).toEqual({ reactions: 3, statuses: 6, views: 1 });
    const statusIds = async (userId: string) =>
      (await w.db.select({ id: statuses.id }).from(statuses).where(eq(statuses.audienceId, userId)))
        .map((row) => row.id)
        .sort();
    const [sa, sb] = [await statusIds(a.id), await statusIds(b.id)];
    expect(new Set([...sa, ...sb]).size).toBe(12);

    // Changing one account's data leaves the other's alone.
    await w.chats.markRead(a.id, chatOfA.id);
    expect((await view(b)).byName.get("Imogen Varley")!.unread).toBe(2);
  });
});

describe("OnboardingService.onboardIfEmpty", () => {
  it("onboards an account with no contacts, once", async () => {
    const user = await w.user();
    expect(await w.onboarding.onboardIfEmpty(user.id)).toBe(true);
    expect(await w.onboarding.onboardIfEmpty(user.id)).toBe(false);
    expect(await rowsFor(user.id)).toEqual({ contacts: 14, memberships: 11 });
    const v = await view(user);
    expect(v.chatList).toHaveLength(11);
  });

  it("onboards once when called at the same time", async () => {
    const user = await w.user();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => w.onboarding.onboardIfEmpty(user.id)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await rowsFor(user.id)).toEqual({ contacts: 14, memberships: 11 });
    const [{ n }] = await w.db
      .select({ n: count() })
      .from(messages)
      .innerJoin(
        chatMembers,
        and(eq(chatMembers.chatId, messages.chatId), eq(chatMembers.userId, user.id)),
      );
    expect(n).toBe(153);
  });

  it("does nothing for an account that already has any contact, even an unsaved one", async () => {
    const user = await w.user();
    const [other] = await w.people(1);
    await w.befriend(user, [other!]);
    await w.db.update(contacts).set({ saved: false }).where(eq(contacts.ownerId, user.id));

    expect(await w.onboarding.onboardIfEmpty(user.id)).toBe(false);
    expect(await rowsFor(user.id)).toEqual({ contacts: 1, memberships: 0 });
  });

  it("leaves other accounts alone", async () => {
    const [a, b] = [await w.user(), await w.user()];
    await w.onboarding.onboardIfEmpty(a.id);
    expect(await rowsFor(b.id)).toEqual({ contacts: 0, memberships: 0 });
  });
});

describe("OnboardingService: failure and the bots", () => {
  it("leaves nothing for the account when the transaction rolls back (the bots may stay)", async () => {
    const user = await w.user();
    await w.onboarding.ensureBots();
    await expect(
      w.db.transaction(async (tx) => {
        await w.onboarding.onboard(tx, user.id);
        throw new Error("registration failed after onboarding");
      }),
    ).rejects.toThrow("registration failed");

    expect(await rowsFor(user.id)).toEqual({ contacts: 0, memberships: 0 });
    // The reactions, statuses and views go with the rest.
    expect(await extrasFor(user.id)).toEqual({ reactions: 0, statuses: 0, views: 0 });
    const [{ n: chatsMade }] = await w.db
      .select({ n: count() })
      .from(chats)
      .where(eq(chats.createdBy, user.id));
    expect(chatsMade).toBe(0);
    const bots = await w.db
      .select({ id: users.id })
      .from(users)
      .where(
        inArray(
          users.id,
          SEED_PEOPLE.map((p) => botId(p.key)),
        ),
      );
    expect(bots).toHaveLength(14);
    // And it can be done again afterwards.
    expect(await w.onboarding.onboardIfEmpty(user.id)).toBe(true);
    expect(await extrasFor(user.id)).toEqual({ reactions: 3, statuses: 6, views: 1 });
  });

  it("makes the bots once per instance, even when many callers ask at once", async () => {
    const service = new OnboardingService(w.db);
    const spy = vi.spyOn(w.handle.pool, "query");
    spy.mockClear();
    await Promise.all([service.ensureBots(), service.ensureBots(), service.ensureBots()]);
    const first = spy.mock.calls.length;
    await service.ensureBots();
    await service.ensureBots();
    const after = spy.mock.calls.length;
    spy.mockRestore();
    expect(first).toBe(1);
    expect(after).toBe(1);
  });

  it("never overwrites a bot that exists, however often a new instance starts", async () => {
    await w.onboarding.ensureBots();
    await w.db
      .update(users)
      .set({ name: "Renamed Imogen" })
      .where(eq(users.id, botId("c1")));
    await new OnboardingService(w.db).ensureBots();
    const [row] = await w.db
      .select()
      .from(users)
      .where(eq(users.id, botId("c1")));
    expect(row!.name).toBe("Renamed Imogen");
    await w.db
      .update(users)
      .set({ name: "Imogen Varley" })
      .where(eq(users.id, botId("c1")));
    const bots = await w.db
      .select({ id: users.id })
      .from(users)
      .where(
        inArray(
          users.id,
          SEED_PEOPLE.map((p) => botId(p.key)),
        ),
      );
    expect(bots).toHaveLength(14);
  });

  it("does not remember a failure: the next call tries again", async () => {
    let attempts = 0;
    const fakeDb = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => {
            attempts += 1;
            return attempts === 1
              ? Promise.reject(new Error("connection refused"))
              : Promise.resolve([]);
          },
        }),
      }),
    };
    const service = new OnboardingService(fakeDb as never);
    await expect(service.ensureBots()).rejects.toThrow("connection refused");
    await expect(service.ensureBots()).resolves.toBeUndefined();
    await service.ensureBots();
    expect(attempts).toBe(2);
  });
});
