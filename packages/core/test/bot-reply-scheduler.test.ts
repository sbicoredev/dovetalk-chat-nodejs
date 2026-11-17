import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  BOT_REPLY_DELAY_MS,
  BOT_REPLY_JOB,
  BOT_TYPING_DELAY_MS,
  BOT_TYPING_JOB,
  botReplyJobId,
  botTypingJobId,
} from "../src/index.js";
import { createWorld, type World } from "./support/world.js";

let w: World;
let off: World;
beforeAll(async () => {
  w = await createWorld({ botReplies: true });
  off = await createWorld();
});
afterAll(async () => {
  await w.close();
  await off.close();
});

async function chatWithBot(world: World) {
  const me = await world.user();
  const bot = await world.bot();
  const [contactId] = await world.befriend(me, [bot]);
  const { chat } = await world.chats.create(me.id, { type: "direct", contactId: contactId! });
  return { me, bot, chat };
}

const say = (world: World, userId: string, chatId: string, clientId: string, text = "hello") =>
  world.messages.send(userId, chatId, { kind: "text", text, clientId });

/** The delayed jobs waiting in this world's queue. */
const waiting = (world: World) => world.queues.botReplies.getDelayed();

describe("BotReplyScheduler", () => {
  it("queues a typing job and a reply job, with the mock's delays, when a person writes to a bot", async () => {
    const { me, chat } = await chatWithBot(w);
    const before = Date.now();

    const { message } = await say(w, me.id, chat.id, "c1");
    await w.botReplies.idle();

    const typing = await w.queues.botReplies.getJob(botTypingJobId(message.id));
    const reply = await w.queues.botReplies.getJob(botReplyJobId(message.id));
    expect(typing).toMatchObject({
      name: BOT_TYPING_JOB,
      opts: { delay: BOT_TYPING_DELAY_MS },
      data: { chatId: chat.id, messageId: message.id, senderId: me.id },
    });
    expect(reply).toMatchObject({
      name: BOT_REPLY_JOB,
      opts: { delay: BOT_REPLY_DELAY_MS, attempts: 5 },
      data: { chatId: chat.id, messageId: message.id, senderId: me.id },
    });
    // The typing job knows when the reply is due, so it can tell it is too late to show typing.
    expect(reply?.data.replyAt).toBeGreaterThanOrEqual(before + BOT_REPLY_DELAY_MS);
    expect(reply?.data.replyAt).toBeLessThan(Date.now() + BOT_REPLY_DELAY_MS);
  });

  it("holds one answer per chat: a second message while one is pending queues nothing", async () => {
    const { me, chat } = await chatWithBot(w);

    const first = await say(w, me.id, chat.id, "a");
    const second = await say(w, me.id, chat.id, "b");
    await w.botReplies.idle();

    expect(await w.queues.botReplies.getJob(botReplyJobId(first.message.id))).toBeDefined();
    expect(await w.queues.botReplies.getJob(botReplyJobId(second.message.id))).toBeUndefined();
  });

  it("answers again once the hold is let go, and only the one who took it can let go", async () => {
    const { me, chat } = await chatWithBot(w);
    const first = await say(w, me.id, chat.id, "a");
    await w.botReplies.idle();

    await w.botReplies.release(chat.id, "some-other-message");
    const blocked = await say(w, me.id, chat.id, "b");
    await w.botReplies.idle();
    expect(await w.queues.botReplies.getJob(botReplyJobId(blocked.message.id))).toBeUndefined();

    await w.botReplies.release(chat.id, first.message.id);
    const again = await say(w, me.id, chat.id, "c");
    await w.botReplies.idle();
    expect(await w.queues.botReplies.getJob(botReplyJobId(again.message.id))).toBeDefined();
  });

  it("queues nothing for a replay of a send, which changed nothing", async () => {
    const { me, chat } = await chatWithBot(w);
    const first = await say(w, me.id, chat.id, "same");
    await w.botReplies.idle();
    await w.botReplies.release(chat.id, first.message.id);
    const jobsBefore = (await waiting(w)).length;

    const replay = await say(w, me.id, chat.id, "same");
    await w.botReplies.idle();

    expect(replay.created).toBe(false);
    expect(await waiting(w)).toHaveLength(jobsBefore);
  });

  it("queues nothing in a chat with another person", async () => {
    const [me, them] = await w.people(2);
    const [contactId] = await w.befriend(me!, [them!]);
    const { chat } = await w.chats.create(me!.id, { type: "direct", contactId: contactId! });
    const before = (await waiting(w)).length;

    await say(w, me!.id, chat.id, "hi");
    await w.botReplies.idle();

    expect(await waiting(w)).toHaveLength(before);
  });

  it("queues nothing when the bot is the one writing", async () => {
    const { me, bot, chat } = await chatWithBot(w);
    // A chat opens on the bot's side with the first message to it.
    await say(w, me.id, chat.id, "hello bot");
    await w.botReplies.idle();
    const before = (await waiting(w)).length;

    await say(w, bot.id, chat.id, "bot-says-hi");
    await w.botReplies.idle();

    expect(await waiting(w)).toHaveLength(before);
  });

  it("does not queue for a forwarded copy, as in the mock", async () => {
    const { me, chat } = await chatWithBot(w);
    const other = await chatWithBot(w);
    const original = await w.say(chat.id, me.id, "pass it on");
    const before = (await waiting(w)).length;

    await w.messages.forward(me.id, original.id, [chat.id]);
    await w.botReplies.idle();

    expect(other).toBeDefined();
    expect(await waiting(w)).toHaveLength(before);
  });

  it("lets the send succeed, and the chat answer again, when Redis cannot take the jobs", async () => {
    const { me, chat } = await chatWithBot(w);
    const add = vi
      .spyOn(w.queues.botReplies, "addBulk")
      .mockRejectedValueOnce(new Error("redis is away"));

    const first = await say(w, me.id, chat.id, "a");
    await w.botReplies.idle();
    expect(first.created).toBe(true);
    expect(add).toHaveBeenCalledTimes(1);

    // The failed attempt let go of the chat, so the next message can still be answered.
    const next = await say(w, me.id, chat.id, "b");
    await w.botReplies.idle();
    expect(await w.queues.botReplies.getJob(botReplyJobId(next.message.id))).toBeDefined();
    add.mockRestore();
  });

  it("does nothing, and opens no queue, where bot replies are off", async () => {
    const { me, chat } = await chatWithBot(off);

    await say(off, me.id, chat.id, "hi");
    await off.botReplies.idle();

    expect(off.botReplies.enabled).toBe(false);
    const keys = await off.redis.keys(`${off.queues.prefix}*`);
    expect(keys).toEqual([]);
  });
});
