import { and, eq } from "drizzle-orm";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { BotReplyScheduler, botFor, findBotCandidates, REDIS } from "@dovetalk/core";
import { schema } from "@dovetalk/db";

import { BotReplyHandler } from "../src/jobs/bot-reply.handler.js";
import {
  befriend,
  createInfra,
  eventually,
  type Infra,
  makeBot,
  makePerson,
  type RunningWorker,
  servicesOf,
  startApiSide,
  startWorker,
} from "./support/harness.js";

const { messages, chatMembers, contacts } = schema;

let infra: Infra;
beforeAll(async () => {
  infra = await createInfra();
});
afterAll(() => infra.close());

const open: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(open.splice(0).map((app) => app.close()));
});

async function boot() {
  const worker = await startWorker(infra);
  open.push(worker.app);
  return worker;
}
async function bootApi() {
  const api = await startApiSide(infra);
  open.push(api);
  return api;
}

/** A person, a bot they know and their chat, made through the services the API uses. */
async function scene(app: RunningWorker["app"]) {
  const s = servicesOf(app);
  const me = await makePerson(s.db);
  const bot = await makeBot(s.db, { name: "Bo Bot" });
  const [contactId] = await befriend(s.db, me, [bot]);
  const { chat } = await s.chats.create(me.id, { type: "direct", contactId: contactId as string });
  return { s, me, bot, contactId: contactId as string, chat };
}

const botMessages = (s: ReturnType<typeof servicesOf>, chatId: string, botId: string) =>
  s.db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.senderId, botId)));

const unreadOf = async (s: ReturnType<typeof servicesOf>, chatId: string, userId: string) =>
  (
    await s.db
      .select({ n: chatMembers.unreadCount })
      .from(chatMembers)
      .where(and(eq(chatMembers.chatId, chatId), eq(chatMembers.userId, userId)))
  )[0]?.n;

describe("a bot answering a person, end to end", () => {
  it("types, stops typing and answers, in that order, and the answer counts as unread", async () => {
    const worker = await boot();
    const api = await bootApi();
    const { s, me, bot, contactId, chat } = await scene(api);

    await s.messages.send(me.id, chat.id, { kind: "text", text: "ping", clientId: "p1" });

    const reply = await eventually(async () => (await botMessages(s, chat.id, bot.id))[0], {
      message: "The bot never answered.",
    });
    await vi.waitFor(() => expect(worker.sentTo(me.id, "message:new")).toHaveLength(1));

    const kinds = worker.sentTo(me.id).map((e) => {
      if (e.event === "typing") {
        return `typing:${e.payload.isTyping}`;
      }
      return e.event;
    });
    expect(kinds.indexOf("typing:true")).toBeGreaterThanOrEqual(0);
    expect(kinds.indexOf("typing:true")).toBeLessThan(kinds.indexOf("typing:false"));
    expect(kinds.indexOf("typing:false")).toBeLessThan(kinds.indexOf("message:new"));

    // The person sees the bot under their own contact id for it.
    expect(worker.sentTo(me.id, "typing")[0]?.payload).toMatchObject({
      chatId: chat.id,
      contactId,
      name: "Bo",
    });
    expect(worker.sentTo(me.id, "message:new")[0]?.payload).toMatchObject({
      message: { id: reply.id, senderId: contactId, text: reply.text, kind: "text" },
    });
    expect(await unreadOf(s, chat.id, me.id)).toBe(1);
  });

  it("answers a burst of messages once, as the mock does", async () => {
    await boot();
    const api = await bootApi();
    const { s, me, bot, chat } = await scene(api);

    for (const n of [1, 2, 3]) {
      await s.messages.send(me.id, chat.id, { kind: "text", text: `m${n}`, clientId: `b${n}` });
    }
    await eventually(async () => (await botMessages(s, chat.id, bot.id)).length > 0);
    await new Promise((resolve) => setTimeout(resolve, 600));

    expect(await botMessages(s, chat.id, bot.id)).toHaveLength(1);
  });

  it("answers the next message after the first answer, so the chat is not stuck", async () => {
    await boot();
    const api = await bootApi();
    const { s, me, bot, chat } = await scene(api);

    await s.messages.send(me.id, chat.id, { kind: "text", text: "one", clientId: "n1" });
    await eventually(async () => (await botMessages(s, chat.id, bot.id)).length === 1);
    // The reply job lets go of the chat just after sending.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await s.messages.send(me.id, chat.id, { kind: "text", text: "two", clientId: "n2" });

    await eventually(async () => (await botMessages(s, chat.id, bot.id)).length === 2);
  });

  it("loses no reply when the worker restarts before the job is due", async () => {
    const first = await boot();
    const api = await bootApi();
    const { s, me, bot, chat } = await scene(api);

    await s.messages.send(me.id, chat.id, { kind: "text", text: "ping", clientId: "r1" });
    // Gone before either job runs.
    await first.app.close();
    open.splice(open.indexOf(first.app), 1);
    expect(await botMessages(s, chat.id, bot.id)).toHaveLength(0);

    const second = await boot();
    const reply = await eventually(async () => (await botMessages(s, chat.id, bot.id))[0], {
      message: "The reply was lost with the first worker.",
    });
    expect(reply.text).toBeTruthy();
    // The row is written first, and announced a moment later.
    await eventually(() => second.sentTo(me.id, "message:new").length === 1 || undefined, {
      message: "The reply was never announced.",
    });
    await second.flush();
    expect(second.sentTo(me.id, "message:new")).toHaveLength(1);
  });

  it("runs each job once when two workers are running", async () => {
    const one = await boot();
    const two = await boot();
    const api = await bootApi();
    const handlers = [one, two].map((w) => w.get(BotReplyHandler));
    const replies = handlers.map((h) => vi.spyOn(h, "reply"));
    const typings = handlers.map((h) => vi.spyOn(h, "typing"));

    const s = servicesOf(api);
    const rooms = await Promise.all(
      Array.from({ length: 6 }, async () => {
        const me = await makePerson(s.db);
        const bot = await makeBot(s.db);
        const [contactId] = await befriend(s.db, me, [bot]);
        const { chat } = await s.chats.create(me.id, {
          type: "direct",
          contactId: contactId as string,
        });
        return { me, bot, chat };
      }),
    );
    await Promise.all(
      rooms.map(({ me, chat }) =>
        s.messages.send(me.id, chat.id, { kind: "text", text: "hi", clientId: "x" }),
      ),
    );

    await eventually(
      async () => {
        const counts = await Promise.all(rooms.map((r) => botMessages(s, r.chat.id, r.bot.id)));
        return counts.every((c) => c.length === 1);
      },
      { message: "Not every chat got its answer." },
    );

    const total = (spies: typeof replies) => spies.reduce((n, spy) => n + spy.mock.calls.length, 0);
    expect(total(replies)).toBe(6);
    expect(total(typings)).toBe(6);
  });
});

describe("BotReplyHandler", () => {
  /** A person's message in the scene, and the job data the API would have queued for it. */
  async function message(worker: RunningWorker) {
    const sc = await scene(worker.app);
    const sent = await sc.s.messages.send(sc.me.id, sc.chat.id, {
      kind: "text",
      text: "hello",
      clientId: "h",
    });
    // The chat's creation and the person's own message were announced too. Those are set-up.
    await worker.quiet();
    return {
      ...sc,
      data: {
        chatId: sc.chat.id,
        messageId: sent.message.id,
        senderId: sc.me.id,
        replyAt: Date.now() + 2400,
      },
    };
  }

  it("is safe to run twice: the second run changes nothing, not even the unread count", async () => {
    const worker = await boot();
    const { s, me, bot, chat, data } = await message(worker);
    const handler = worker.get(BotReplyHandler);

    expect(await handler.reply(data)).toBe("sent");
    expect(await handler.reply(data)).toBe("already-sent");
    await worker.flush();

    const sent = await botMessages(s, chat.id, bot.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.clientId).toBe(`bot-reply:${data.messageId}`);
    expect(await unreadOf(s, chat.id, me.id)).toBe(1);
    expect(worker.sentTo(me.id, "message:new")).toHaveLength(1);
  });

  it("says the same thing on a retry", async () => {
    const worker = await boot();
    const { s, bot, chat, data } = await message(worker);
    const handler = worker.get(BotReplyHandler);

    await handler.reply(data);
    const [first] = await botMessages(s, chat.id, bot.id);
    // Same message id, so the same line and the same bot would be chosen again.
    const bots = await findBotCandidates(s.db, chat.id, data.senderId);
    expect(botFor(bots, data.messageId).id).toBe(first?.senderId);
  });

  it("skips typing when the reply is already due, using the clock", async () => {
    const worker = await boot();
    const { me, data } = await message(worker);
    const handler = worker.get(BotReplyHandler);
    vi.useFakeTimers({ toFake: ["Date"] });

    vi.setSystemTime(data.replyAt - 1);
    expect(await handler.typing(data)).toBe("typing");
    vi.setSystemTime(data.replyAt);
    expect(await handler.typing(data)).toBe("late");
    vi.setSystemTime(data.replyAt + 60_000);
    expect(await handler.typing(data)).toBe("late");
    await worker.flush();

    expect(worker.sentTo(me.id, "typing")).toHaveLength(1);
  });

  it("does not answer a chat the person deleted in the meantime, or bring it back", async () => {
    const worker = await boot();
    const { s, me, bot, chat, data } = await message(worker);
    await s.chats.remove(me.id, chat.id);
    const handler = worker.get(BotReplyHandler);

    expect(await handler.typing(data)).toBe("nobody");
    expect(await handler.reply(data)).toBe("nobody");
    await worker.flush();

    expect(await botMessages(s, chat.id, bot.id)).toHaveLength(0);
    expect(worker.sentTo(me.id, "message:new")).toHaveLength(0);
    expect(worker.sentTo(me.id, "typing")).toHaveLength(0);
  });

  it("does not answer once the person has blocked the bot", async () => {
    const worker = await boot();
    const { s, me, bot, contactId, chat, data } = await message(worker);
    await s.db.update(contacts).set({ blocked: true }).where(eq(contacts.id, contactId));
    const handler = worker.get(BotReplyHandler);

    expect(await handler.reply(data)).toBe("nobody");
    await worker.flush();

    expect(await botMessages(s, chat.id, bot.id)).toHaveLength(0);
    expect(worker.sentTo(me.id, "message:new")).toHaveLength(0);
  });

  it("answers a group with one of its bots, the same one for typing and for the reply", async () => {
    const worker = await boot();
    const s = servicesOf(worker.app);
    const me = await makePerson(s.db);
    const bots = await Promise.all([
      makeBot(s.db, { name: "Ann" }),
      makeBot(s.db, { name: "Ben" }),
      makeBot(s.db, { name: "Cy" }),
    ]);
    const contactIds = await befriend(s.db, me, bots);
    const { chat } = await s.chats.create(me.id, {
      type: "group",
      name: "Crew",
      memberIds: contactIds,
    });
    const sent = await s.messages.send(me.id, chat.id, {
      kind: "text",
      text: "hey all",
      clientId: "g",
    });
    const data = {
      chatId: chat.id,
      messageId: sent.message.id,
      senderId: me.id,
      replyAt: Date.now() + 2400,
    };
    const handler = worker.get(BotReplyHandler);
    await worker.quiet();

    await handler.typing(data);
    await handler.reply(data);
    await worker.flush();

    const typing = worker.sentTo(me.id, "typing")[0]?.payload;
    const answer = worker.sentTo(me.id, "message:new")[0]?.payload as {
      message: { senderId: string };
    };
    expect(contactIds).toContain(answer.message.senderId);
    expect(typing?.contactId).toBe(answer.message.senderId);
  });

  it("lets a chat answer again when the reply job is given up on", async () => {
    const worker = await boot();
    const api = await bootApi();
    const { s, me, chat } = await scene(api);
    const sent = await s.messages.send(me.id, chat.id, { kind: "text", text: "x", clientId: "gu" });
    const data = { chatId: chat.id, messageId: sent.message.id, senderId: me.id, replyAt: 0 };

    await worker.get(BotReplyHandler).giveUp(data);

    const key = api.get(BotReplyScheduler).pendingKey(chat.id);
    expect(await api.get<Redis>(REDIS).get(key)).toBeNull();
  });
});
