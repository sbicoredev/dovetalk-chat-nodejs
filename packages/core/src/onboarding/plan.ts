import { STATUS_TTL_MS } from "@dovetalk/contracts";
import {
  type NewChat,
  type NewChatMember,
  type NewContact,
  type NewMessage,
  type NewMessageReaction,
  type NewStatus,
  type NewStatusView,
  newId,
} from "@dovetalk/db";

import { directKey } from "../conversations/ids.js";
import { botId } from "./bots.js";
import {
  SEED_DIRECT_CHATS,
  SEED_GROUPS,
  SEED_PEOPLE,
  SEED_STATUSES,
  type SeedMessage,
} from "./seed-data.js";
import { makeBars } from "./waveform.js";

type WithId<T> = T & { id: string };

/** The rows that give one new account its starting contacts, chats and messages. */
export interface OnboardingPlan {
  chats: WithId<NewChat>[];
  contacts: WithId<NewContact>[];
  members: NewChatMember[];
  messages: WithId<NewMessage>[];
  /** Who reacted to which seeded message. */
  reactions: NewMessageReaction[];
  /** The shared bots' statuses, each meant for this one account (`audience_id`). */
  statuses: WithId<NewStatus>[];
  /** The statuses this account has already seen. */
  statusViews: NewStatusView[];
}

export interface PlanInput {
  /** Epoch milliseconds. Every seeded time is "so many minutes before this". */
  now: number;
  /** The new account. */
  userId: string;
}

const MINUTE = 60_000;

/**
 * Turns the seed data into rows for one account. It touches no database, so what a new account
 * gets can be checked exactly. The shared bots must already exist (`OnboardingService`).
 *
 * The rules follow the prototype's `createSeed`, which this replaces:
 * - Chats are built in the order direct c1 to c9, then the hikers, then the studio crew.
 * - Inside a chat, messages are sorted oldest first by their `ago` (equal times keep the order
 *   they were written in), numbered 1, 2, 3 and timed `now - ago` minutes.
 * - Voice bars come from ONE counter that goes up by one for every message, in build order
 *   across all chats, so a seeded voice message looks the same in the prototype and here.
 */
export function planOnboarding({ userId, now }: PlanInput): OnboardingPlan {
  const plan: OnboardingPlan = {
    contacts: [],
    chats: [],
    members: [],
    messages: [],
    reactions: [],
    statuses: [],
    statusViews: [],
  };
  let barsCounter = 0;

  const at = (minutesAgo: number) => new Date(now - minutesAgo * MINUTE);
  const senderOf = (from: string): string => (from === "me" ? userId : botId(from));

  // One saved contact per bot. about and hue stay null so the bot's own profile shows through.
  // Ids come from newId() in c1..c14 order: UUIDv7 is monotonic, and the contact list is sorted
  // by (created_at, id) while every row here shares one created_at.
  for (const person of SEED_PEOPLE) {
    plan.contacts.push({
      id: newId(),
      ownerId: userId,
      linkedUserId: botId(person.key),
      name: person.name,
      phone: person.phone,
    });
  }

  function kindOf(isSystem: boolean, isVoice: boolean): "system" | "voice" | "text" {
    if (isSystem) {
      return "system";
    }
    return isVoice ? "voice" : "text";
  }

  /** Numbers one chat's messages and adds them to the plan. Returns the first message's time. */
  const addMessages = (chatId: string, specs: SeedMessage[]): Date | null => {
    // Array.prototype.sort is stable, so specs with the same `ago` keep their written order.
    const sorted = [...specs].sort((a, b) => b.ago - a.ago);
    const ids = new Map<string, string>();
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one pass turns a seed spec into every row it needs (message, reply link, system event, voice bars).
    sorted.forEach((spec, index) => {
      barsCounter += 1;
      const id = newId();
      if (spec.key) {
        ids.set(spec.key, id);
      }

      let replyToId: string | null = null;
      if (spec.replyKey) {
        replyToId = ids.get(spec.replyKey) ?? null;
        if (!replyToId) {
          throw new Error(
            `Seed message replies to "${spec.replyKey}", which is not earlier in the chat.`,
          );
        }
      }

      const isSystem = spec.from === "system";
      const isVoice = spec.voice !== undefined;
      if (isSystem && !spec.groupCreatedBy) {
        throw new Error("A seeded system message needs groupCreatedBy.");
      }
      plan.messages.push({
        id,
        chatId,
        seq: index + 1,
        senderId: isSystem ? null : senderOf(spec.from),
        kind: kindOf(isSystem, isVoice),
        // The words of a system message are made per reader, from the event.
        text: isSystem ? null : (spec.text ?? null),
        duration: spec.voice ?? null,
        bars: isVoice ? makeBars(barsCounter * 7919) : null,
        replyToId,
        event:
          isSystem && spec.groupCreatedBy
            ? { type: "group_created", actorId: botId(spec.groupCreatedBy) }
            : null,
        createdAt: at(spec.ago),
      });
      // One second apart, so the order they are shown in is the order written here.
      let n = 0;
      for (const [emoji, people] of Object.entries(spec.reactions ?? {})) {
        for (const key of people) {
          n += 1;
          plan.reactions.push({
            messageId: id,
            userId: botId(key),
            emoji,
            createdAt: new Date(at(spec.ago).getTime() + n * 1000),
          });
        }
      }
    });
    const [newest] = sorted;
    return newest ? at(newest.ago) : null;
  };

  for (const seed of SEED_DIRECT_CHATS) {
    const chatId = newId();
    const bot = botId(seed.person);
    const createdAt = addMessages(chatId, seed.messages) ?? new Date(now);
    plan.chats.push({
      id: chatId,
      type: "direct",
      name: null,
      hue: null,
      directKey: directKey(userId, bot),
      createdBy: userId,
      lastSeq: seed.messages.length,
      createdAt,
    });
    plan.members.push(
      {
        chatId,
        userId,
        unreadCount: seed.unread,
        archived: seed.archived,
        pinned: seed.pinned,
        joinedAt: createdAt,
      },
      { chatId, userId: bot, joinedAt: createdAt },
    );
  }

  for (const seed of SEED_GROUPS) {
    const chatId = newId();
    const firstMessageAt = addMessages(chatId, seed.messages);
    const createdAt =
      seed.createdAgo === undefined ? (firstMessageAt ?? new Date(now)) : at(seed.createdAgo);
    plan.chats.push({
      id: chatId,
      type: "group",
      name: seed.name,
      hue: seed.hue,
      directKey: null,
      createdBy: senderOf(seed.createdBy),
      lastSeq: seed.messages.length,
      createdAt,
    });
    // Every bot gets a row (the worker sends as them). They join one millisecond apart, in the
    // order the group lists them, so the members come back in that order.
    plan.members.push({
      chatId,
      userId,
      unreadCount: seed.unread,
      pinned: seed.pinned,
      joinedAt: createdAt,
    });
    seed.members.forEach((key, index) => {
      plan.members.push({
        chatId,
        userId: botId(key),
        joinedAt: new Date(createdAt.getTime() + index),
      });
    });
  }

  // Each status is the bot's own, for this account only (`audience_id`): the bots are shared by
  // everyone, and the notes must not pile up on them or show to other accounts.
  for (const seed of SEED_STATUSES) {
    const id = newId();
    const createdAt = at(seed.ago);
    plan.statuses.push({
      id,
      ownerId: botId(seed.person),
      audienceId: userId,
      text: seed.text,
      color: seed.color,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + STATUS_TTL_MS),
    });
    if (seed.seen) {
      plan.statusViews.push({ statusId: id, viewerId: userId, viewedAt: new Date(now) });
    }
  }

  return plan;
}
