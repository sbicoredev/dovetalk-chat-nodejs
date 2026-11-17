import { describe, expect, it } from "vitest";

import { byCodeUnit } from "@dovetalk/testkit";

import { directKey } from "../src/conversations/ids.js";
import { botId, seedBotRows } from "../src/onboarding/bots.js";
import { type OnboardingPlan, planOnboarding } from "../src/onboarding/plan.js";
import {
  SEED_DIRECT_CHATS,
  SEED_GROUPS,
  SEED_PEOPLE,
  SEED_STATUSES,
} from "../src/onboarding/seed-data.js";
import { makeBars } from "../src/onboarding/waveform.js";

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const NOW = 1_700_000_000_000;
const MIN = 60_000;

const plan = planOnboarding({ userId: USER, now: NOW });

const directOf = (key: string, p: OnboardingPlan = plan) =>
  p.chats.find((c) => c.directKey === directKey(USER, botId(key)))!;
const groupOf = (name: string, p: OnboardingPlan = plan) => p.chats.find((c) => c.name === name)!;
const messagesOf = (chatId: string, p: OnboardingPlan = plan) =>
  p.messages.filter((m) => m.chatId === chatId);
const membership = (chatId: string, userId: string) =>
  plan.members.find((m) => m.chatId === chatId && m.userId === userId)!;

describe("the shared bots", () => {
  it("have the same ids on every run, whoever is onboarded", () => {
    expect(botId("c1")).toBe("4e876f91-3342-5f85-8372-a1a6cc935398");
    expect(botId("c14")).toBe("af02ef69-df13-574d-a7c6-91a3298b4744");
    const again = planOnboarding({ userId: OTHER_USER, now: NOW + 1 });
    expect(again.contacts.map((c) => c.linkedUserId)).toEqual(
      plan.contacts.map((c) => c.linkedUserId),
    );
  });

  it("are 14 distinct bot users with no email, password or phone of their own", () => {
    const rows = seedBotRows();
    expect(rows).toHaveLength(14);
    expect(new Set(rows.map((r) => r.id)).size).toBe(14);
    for (const [i, row] of rows.entries()) {
      const person = SEED_PEOPLE[i]!;
      expect(row).toMatchObject({
        id: botId(person.key),
        name: person.name,
        about: person.about,
        hue: person.hue,
        isBot: true,
        botOnlineDefault: person.online,
      });
      expect(row.email ?? null).toBeNull();
      expect(row.passwordHash ?? null).toBeNull();
      expect(row.phone ?? null).toBeNull();
    }
    expect(rows.filter((r) => r.botOnlineDefault).map((r) => r.name)).toEqual([
      "Imogen Varley",
      "Priya Anand",
      "Linnea Hoff",
      "Amara Okafor",
      "Noor Haddad",
    ]);
  });
});

describe("planOnboarding: contacts", () => {
  it("gives one saved contact per bot, in c1 to c14 order, with the phone on the contact", () => {
    expect(plan.contacts).toHaveLength(14);
    plan.contacts.forEach((contact, i) => {
      const person = SEED_PEOPLE[i]!;
      expect(contact).toMatchObject({
        ownerId: USER,
        linkedUserId: botId(person.key),
        name: person.name,
        phone: person.phone,
      });
      // The bot's profile shows through until the owner edits it.
      expect(contact.about ?? null).toBeNull();
      expect(contact.hue ?? null).toBeNull();
      expect(contact.avatarUrl ?? null).toBeNull();
      expect(contact.saved ?? true).toBe(true);
      expect(contact.blocked ?? false).toBe(false);
    });
  });

  it("makes ids that sort in list order (the list is ordered by created_at, id)", () => {
    const ids = plan.contacts.map((c) => c.id);
    expect(ids).toEqual([...ids].sort(byCodeUnit));
    expect(new Set(ids).size).toBe(14);
  });
});

describe("planOnboarding: chats", () => {
  it("makes 11 chats: nine direct and two groups, in build order", () => {
    expect(plan.chats).toHaveLength(11);
    expect(plan.chats.map((c) => c.type)).toEqual([
      ...new Array(9).fill("direct"),
      "group",
      "group",
    ]);
    expect(plan.chats.slice(9).map((c) => c.name)).toEqual(["Weekend hikers", "Studio crew"]);
  });

  it("keys each direct chat to the viewer and the bot, with no name or colour of its own", () => {
    SEED_DIRECT_CHATS.forEach((seed, i) => {
      const chat = plan.chats[i]!;
      expect(chat).toMatchObject({
        type: "direct",
        directKey: directKey(USER, botId(seed.person)),
        createdBy: USER,
      });
      expect(chat.name ?? null).toBeNull();
      expect(chat.hue ?? null).toBeNull();
    });
  });

  it("has the right number of messages in each chat, and last_seq says so", () => {
    const counts = [77, 5, 6, 3, 3, 2, 2, 2, 2, 47, 4];
    expect(plan.chats.map((c) => messagesOf(c.id).length)).toEqual(counts);
    expect(plan.chats.map((c) => c.lastSeq)).toEqual(counts);
    expect(plan.messages).toHaveLength(153);
  });

  it("lets a bot make the hikers (the viewer can add but not remove) and the viewer the studio", () => {
    expect(groupOf("Weekend hikers")).toMatchObject({
      createdBy: botId("c1"),
      hue: 160,
      directKey: null,
    });
    expect(groupOf("Studio crew")).toMatchObject({ createdBy: USER, hue: 20, directKey: null });
  });

  it("dates a chat by its first message, except the studio crew, which is 400 minutes old", () => {
    for (const chat of plan.chats) {
      const expected =
        chat.name === "Studio crew" ? new Date(NOW - 400 * MIN) : messagesOf(chat.id)[0]!.createdAt;
      expect(chat.createdAt).toEqual(expected);
    }
  });
});

describe("planOnboarding: members", () => {
  it("carries unread, archived and pinned on the viewer's rows", () => {
    const flags = (chatId: string) => {
      const m = membership(chatId, USER);
      return [m.unreadCount ?? 0, m.archived ?? false, m.pinned ?? false];
    };
    const unread = (key: string) => flags(directOf(key).id)[0];
    expect(unread("c1")).toBe(2);
    expect(unread("c3")).toBe(1);
    for (const key of ["c2", "c4", "c5", "c6", "c7", "c8", "c9"]) {
      expect(unread(key)).toBe(0);
    }
    expect(flags(groupOf("Weekend hikers").id)).toEqual([3, false, false]);
    expect(flags(groupOf("Studio crew").id)).toEqual([0, false, true]);

    const archived = plan.members.filter((m) => m.userId === USER && m.archived);
    expect(archived.map((m) => m.chatId)).toEqual([directOf("c8").id, directOf("c9").id]);
    const pinned = plan.members.filter((m) => m.userId === USER && m.pinned);
    expect(pinned.map((m) => m.chatId)).toEqual([groupOf("Studio crew").id]);
  });

  it("leaves everything else at its default: nothing hidden, left, cleared or muted", () => {
    for (const m of plan.members) {
      expect(m.hiddenAt ?? null).toBeNull();
      expect(m.leftAt ?? null).toBeNull();
      expect(m.clearedBeforeSeq ?? 0).toBe(0);
      expect(m.muted ?? false).toBe(false);
    }
  });

  it("gives every bot in a chat a row with no flags, and nobody else", () => {
    const users = (chatId: string) =>
      plan.members.filter((m) => m.chatId === chatId).map((m) => m.userId);
    for (const seed of SEED_DIRECT_CHATS) {
      expect(users(directOf(seed.person).id).sort(byCodeUnit)).toEqual(
        [USER, botId(seed.person)].sort(byCodeUnit),
      );
    }
    expect(users(groupOf("Weekend hikers").id).sort(byCodeUnit)).toEqual(
      [USER, ...["c1", "c3", "c5", "c10"].map(botId)].sort(byCodeUnit),
    );
    expect(users(groupOf("Studio crew").id).sort(byCodeUnit)).toEqual(
      [USER, ...["c2", "c4", "c6"].map(botId)].sort(byCodeUnit),
    );
    for (const m of plan.members.filter((row) => row.userId !== USER)) {
      expect(m.unreadCount ?? 0).toBe(0);
      expect(m.archived ?? false).toBe(false);
      expect(m.pinned ?? false).toBe(false);
    }
    expect(plan.members).toHaveLength(27);
  });

  it("joins group members one millisecond apart, in the order the group lists them", () => {
    for (const seed of SEED_GROUPS) {
      const chat = plan.chats.find((c) => c.name === seed.name)!;
      const others = plan.members
        .filter((m) => m.chatId === chat.id && m.userId !== USER)
        .sort((a, b) => a.joinedAt!.getTime() - b.joinedAt!.getTime());
      expect(others.map((m) => m.userId)).toEqual(seed.members.map(botId));
      for (const [i, m] of others.entries()) {
        expect(m.joinedAt!.getTime()).toBe(chat.createdAt!.getTime() + i);
      }
    }
  });
});

describe("planOnboarding: messages", () => {
  it("numbers each chat 1..n with times that never go back", () => {
    for (const chat of plan.chats) {
      const list = messagesOf(chat.id);
      expect(list.map((m) => m.seq)).toEqual(list.map((_, i) => i + 1));
      for (let i = 1; i < list.length; i += 1) {
        expect(list[i]!.createdAt!.getTime()).toBeGreaterThanOrEqual(
          list[i - 1]!.createdAt!.getTime(),
        );
      }
    }
  });

  it("times each message `ago` minutes before now, and puts the newest last", () => {
    const c1 = messagesOf(directOf("c1").id);
    const last = c1.at(-1)!;
    expect(last).toMatchObject({ text: "Save me a seat and order the burrata." });
    expect(last.createdAt).toEqual(new Date(NOW - 10 * MIN));
    expect(c1.at(-2)!.createdAt).toEqual(new Date(NOW - 14 * MIN));
    // The longest chat is the one that pages: 70 backlog messages plus 7.
    expect(c1).toHaveLength(77);
    expect(c1[0]!.createdAt!.getTime()).toBeLessThan(NOW - 9000 * MIN);
  });

  it("attributes each message to the viewer or to the bot that says it", () => {
    const c2 = messagesOf(directOf("c2").id);
    expect(c2.map((m) => m.senderId === USER)).toEqual([false, true, false, true, false]);
    expect(c2.filter((m) => m.senderId !== USER).every((m) => m.senderId === botId("c2"))).toBe(
      true,
    );
    const hikers = messagesOf(groupOf("Weekend hikers").id);
    const senders = new Set(hikers.map((m) => m.senderId));
    expect(senders).toEqual(new Set([null, USER, ...["c1", "c3", "c5", "c10"].map(botId)]));
  });

  it("writes the hikers' creation note as an event, first in the history, with no text", () => {
    const hikers = messagesOf(groupOf("Weekend hikers").id);
    const note = hikers[0]!;
    expect(note).toMatchObject({
      kind: "system",
      senderId: null,
      text: null,
      seq: 1,
      event: { type: "group_created", actorId: botId("c1") },
      createdAt: new Date(NOW - 20_000 * MIN),
    });
    // It is the only system message anywhere.
    expect(plan.messages.filter((m) => m.kind === "system")).toHaveLength(1);
    for (const m of plan.messages.filter((row) => row.kind !== "system")) {
      expect(m.event ?? null).toBeNull();
      expect(m.senderId).not.toBeNull();
    }
  });

  it("makes the studio crew's messages in order, with the viewer's in the middle", () => {
    const studio = messagesOf(groupOf("Studio crew").id);
    expect(studio.map((m) => m.text)).toEqual([
      "Moodboard is updated, take a look when you can.",
      "Love the green palette.",
      "Agreed. Let us lock the type this week.",
      "I can present the options on Thursday.",
    ]);
    expect(studio[2]!.senderId).toBe(USER);
  });

  it("points every reply at an earlier message in the same chat", () => {
    const replies = plan.messages.filter((m) => m.replyToId);
    expect(replies).toHaveLength(1);
    for (const reply of replies) {
      const target = plan.messages.find((m) => m.id === reply.replyToId)!;
      expect(target.chatId).toBe(reply.chatId);
      expect(target.seq).toBeLessThan(reply.seq!);
    }
    const [reply] = replies;
    const target = plan.messages.find((m) => m.id === reply!.replyToId)!;
    expect(target.text).toBe("Will do. I added two comments on page 3.");
    expect(reply!.text).toBe("Saw them. Fixing both this afternoon.");
  });

  it("gives voice messages a duration and bars, and nothing else any", () => {
    const voice = plan.messages.filter((m) => m.kind === "voice");
    expect(voice).toHaveLength(1);
    expect(voice[0]).toMatchObject({ duration: 14, text: null, chatId: directOf("c3").id, seq: 3 });
    for (const m of plan.messages.filter((row) => row.kind !== "voice")) {
      expect(m.duration ?? null).toBeNull();
      expect(m.bars ?? null).toBeNull();
    }
  });

  it("draws the bars from one counter that counts every message in build order", () => {
    // c1 has 77 messages and c2 has 5 before c3's third message, and none of them is a voice
    // message: a counter that only counted voice messages would give seed 1 * 7919.
    const counter = 77 + 5 + 3;
    expect(plan.messages.find((m) => m.kind === "voice")!.bars).toEqual(makeBars(counter * 7919));
    expect(makeBars(counter * 7919)).not.toEqual(makeBars(7919));
  });

  it("is deterministic apart from who the account is and the ids it makes", () => {
    const strip = (p: OnboardingPlan, userId: string) =>
      JSON.stringify(
        p.messages.map((m) => ({
          seq: m.seq,
          text: m.text,
          bars: m.bars,
          at: m.createdAt,
          sender: m.senderId === userId ? "me" : m.senderId,
        })),
      );
    const again = planOnboarding({ userId: OTHER_USER, now: NOW });
    expect(strip(again, OTHER_USER)).toBe(strip(plan, USER));
  });

  it("moves every time with `now`", () => {
    const later = planOnboarding({ userId: USER, now: NOW + 5 * MIN });
    expect(
      later.messages.at(-1)!.createdAt!.getTime() - plan.messages.at(-1)!.createdAt!.getTime(),
    ).toBe(5 * MIN);
    expect(later.chats[0]!.createdAt!.getTime() - plan.chats[0]!.createdAt!.getTime()).toBe(
      5 * MIN,
    );
  });

  it("makes unique ids and refers only to rows it makes or to the bots", () => {
    const chatIds = new Set(plan.chats.map((c) => c.id));
    const messageIds = plan.messages.map((m) => m.id);
    expect(new Set(messageIds).size).toBe(messageIds.length);
    for (const m of plan.messages) {
      expect(chatIds.has(m.chatId!)).toBe(true);
    }
    for (const m of plan.members) {
      expect(chatIds.has(m.chatId)).toBe(true);
    }
    const known = new Set([USER, ...SEED_PEOPLE.map((p) => botId(p.key))]);
    for (const m of plan.members) {
      expect(known.has(m.userId)).toBe(true);
    }
    for (const senderId of plan.messages.flatMap((m) => (m.senderId ? [m.senderId] : []))) {
      expect(known.has(senderId)).toBe(true);
    }
  });
});

describe("planOnboarding: reactions", () => {
  const textOf = (messageId: string) => plan.messages.find((m) => m.id === messageId)!;

  it("makes the three reactions of the prototype, and no others", () => {
    expect(plan.reactions).toHaveLength(3);
    const summary = plan.reactions.map((r) => [textOf(r.messageId).text, r.emoji, r.userId]);
    expect(summary).toEqual([
      ["Great, see you there.", "❤️", botId("c1")],
      ["In!", "🎉", botId("c1")],
      ["In!", "🎉", botId("c3")],
    ]);
  });

  it("puts them on the viewer's own messages, in the chat they belong to", () => {
    for (const reaction of plan.reactions) {
      expect(textOf(reaction.messageId).senderId).toBe(USER);
    }
    const hikers = groupOf("Weekend hikers");
    expect(textOf(plan.reactions[1]!.messageId).chatId).toBe(hikers.id);
    expect(textOf(plan.reactions[0]!.messageId).chatId).toBe(directOf("c1").id);
  });

  it("dates each one after its message, a second apart, so the order of chips is fixed", () => {
    const [heart, firstParty, secondParty] = plan.reactions;
    const at = (r: (typeof plan.reactions)[number]) => r.createdAt!.getTime();
    for (const r of plan.reactions) {
      expect(at(r)).toBeGreaterThan(textOf(r.messageId).createdAt!.getTime());
    }
    expect(at(heart!) - textOf(heart!.messageId).createdAt!.getTime()).toBe(1000);
    expect(at(secondParty!) - at(firstParty!)).toBe(1000);
  });

  it("gives one person one reaction per message", () => {
    const keys = plan.reactions.map((r) => `${r.messageId}:${r.userId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("planOnboarding: statuses", () => {
  const rows = plan.statuses.map((s) => ({
    owner: SEED_PEOPLE.find((p) => botId(p.key) === s.ownerId)!.key,
    text: s.text,
    color: s.color,
    ago: (NOW - s.createdAt!.getTime()) / MIN,
  }));

  it("makes the six statuses of the prototype, in its order", () => {
    expect(rows).toEqual([
      { owner: "c1", text: "Booked the window table.", color: 1, ago: 25 },
      { owner: "c1", text: "Pasta night, finally.", color: 3, ago: 12 },
      { owner: "c3", text: "Got the call back. Thank you all.", color: 0, ago: 130 },
      { owner: "c11", text: "Studio is open until six today.", color: 2, ago: 300 },
      { owner: "c5", text: "New cutting, day one.", color: 4, ago: 600 },
      { owner: "c9", text: "Back from the coast.", color: 5, ago: 900 },
    ]);
    expect(SEED_STATUSES).toHaveLength(6);
  });

  it("keeps every status for this account only, and for 24 hours", () => {
    for (const s of plan.statuses) {
      expect(s.audienceId).toBe(USER);
      expect(s.expiresAt!.getTime() - s.createdAt!.getTime()).toBe(24 * 60 * MIN);
      // Still showing right after sign-up: the oldest has about nine hours left.
      expect(s.expiresAt!.getTime()).toBeGreaterThan(NOW);
    }
    const ids = plan.statuses.map((s) => s.id);
    expect(new Set(ids).size).toBe(6);
  });

  it("has seen only Hugo's status", () => {
    expect(plan.statusViews).toHaveLength(1);
    const [view] = plan.statusViews;
    const seen = plan.statuses.find((s) => s.id === view!.statusId)!;
    expect(seen.text).toBe("Back from the coast.");
    expect(seen.ownerId).toBe(botId("c9"));
    expect(view!.viewerId).toBe(USER);
  });

  it("keeps two accounts' statuses apart, with ids of their own", () => {
    const other = planOnboarding({ userId: OTHER_USER, now: NOW });
    expect(other.statuses.every((s) => s.audienceId === OTHER_USER)).toBe(true);
    const mine = new Set(plan.statuses.map((s) => s.id));
    expect(other.statuses.some((s) => mine.has(s.id))).toBe(false);
    // The same bots own them, which is why `audience_id` exists.
    expect(other.statuses.map((s) => s.ownerId)).toEqual(plan.statuses.map((s) => s.ownerId));
  });

  it("moves with `now`, expiry included", () => {
    const later = planOnboarding({ userId: USER, now: NOW + 5 * MIN });
    for (const [i, s] of later.statuses.entries()) {
      expect(s.createdAt!.getTime() - plan.statuses[i]!.createdAt!.getTime()).toBe(5 * MIN);
      expect(s.expiresAt!.getTime() - plan.statuses[i]!.expiresAt!.getTime()).toBe(5 * MIN);
    }
  });
});
