import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ChatDto } from "@dovetalk/contracts";
import {
  BOT_REPLY_DELAY_MS,
  BOT_REPLY_JOB,
  BOT_TYPING_DELAY_MS,
  BOT_TYPING_JOB,
  BotReplyScheduler,
  botReplyJobId,
  botTypingJobId,
  JobQueues,
} from "@dovetalk/core";
import { schema } from "@dovetalk/db";

import { createTestApp, type TestApp } from "./support/create-test-app.js";
import { http } from "./support/http.js";

const { contacts } = schema;

/** What the API did about bots, seen from the queue: the jobs it left for a worker to run. */
async function jobsOf(t: TestApp, chatId?: string) {
  // The scheduling runs in the background after the response, so wait for it.
  await t.app.get(BotReplyScheduler, { strict: false }).idle();
  const queue = t.app.get(JobQueues, { strict: false }).botReplies;
  const jobs = await queue.getJobs([
    "delayed",
    "waiting",
    "active",
    "prioritized",
    "completed",
    "failed",
  ]);
  return chatId ? jobs.filter((job) => job.data.chatId === chatId) : jobs;
}

const sortedIds = (ids: (string | undefined)[]) =>
  ids.map((id) => id ?? "").sort((a, b) => a.localeCompare(b));

describe("BOT_REPLIES_ENABLED=true", () => {
  let t: TestApp;
  let h: ReturnType<typeof http>;
  beforeAll(async () => {
    t = await createTestApp({ BOT_REPLIES_ENABLED: "true" });
    h = http(t);
  });
  afterAll(async () => {
    await t.app.get(JobQueues, { strict: false }).botReplies.obliterate({ force: true });
    await t.close();
  });

  it("queues a typing job and a reply job when a message is sent to a bot, and the send does not wait for them", async () => {
    const a = await t.signUp();
    const { chat, contact } = await h.directWith(a, "Priya Anand");

    const started = Date.now();
    const sent = (await h.send(a, chat.id, { text: "hello bot" }).expect(201)).body;
    // The reply is due in 2.4 seconds. The request must not have waited for it.
    expect(Date.now() - started).toBeLessThan(BOT_REPLY_DELAY_MS);

    const jobs = await jobsOf(t);
    expect(sortedIds(jobs.map((job) => job.id))).toEqual(
      sortedIds([botReplyJobId(sent.id), botTypingJobId(sent.id)]),
    );
    const typing = jobs.find((job) => job.name === BOT_TYPING_JOB);
    const reply = jobs.find((job) => job.name === BOT_REPLY_JOB);
    expect(typing?.opts.delay).toBe(BOT_TYPING_DELAY_MS);
    expect(reply?.opts.delay).toBe(BOT_REPLY_DELAY_MS);
    expect(reply?.data).toMatchObject({ chatId: chat.id, messageId: sent.id, senderId: a.user.id });
    expect(contact.name).toBe("Priya Anand");
  });

  it("queues nothing more for a replay of the same send (HTTP 200), or for a burst in the same chat", async () => {
    const a = await t.signUp();
    const { chat } = await h.directWith(a, "Priya Anand");
    const clientId = randomUUID();

    await h.send(a, chat.id, { clientId, text: "first" }).expect(201);
    expect(await jobsOf(t, chat.id)).toHaveLength(2);

    await h.send(a, chat.id, { clientId, text: "first" }).expect(200);
    expect(await jobsOf(t, chat.id)).toHaveLength(2);

    // At most one answer waits per chat, as in the mock: more messages add no more jobs.
    await h.send(a, chat.id, { text: "second" }).expect(201);
    await h.send(a, chat.id, { text: "third" }).expect(201);
    expect(await jobsOf(t, chat.id)).toHaveLength(2);
  });

  it("queues jobs for a message in a group that has bots", async () => {
    const a = await t.signUp();
    const chats = (await h.as(a).get("/chats").expect(200)).body as ChatDto[];
    const group = chats.find((chat) => chat.type === "group");
    expect(group, "the seeded account has a group").toBeDefined();

    const sent = (await h.send(a, (group as ChatDto).id, { text: "hi all" }).expect(201)).body;

    const jobs = await jobsOf(t, (group as ChatDto).id);
    expect(sortedIds(jobs.map((job) => job.id))).toEqual(
      sortedIds([botReplyJobId(sent.id), botTypingJobId(sent.id)]),
    );
  });

  it("queues nothing for a bot the person has blocked", async () => {
    const a = await t.signUp();
    const { chat, contact } = await h.directWith(a, "Priya Anand");
    await t.db.update(contacts).set({ blocked: true }).where(eq(contacts.id, contact.id));

    // A blocked contact cannot be written to, so there is nothing for the bot to answer.
    await h.send(a, chat.id, { text: "anyone?" }).expect(403);

    expect(await jobsOf(t, chat.id)).toHaveLength(0);
  });
});

describe("BOT_REPLIES_ENABLED=false", () => {
  let t: TestApp;
  let h: ReturnType<typeof http>;
  beforeAll(async () => {
    t = await createTestApp({ BOT_REPLIES_ENABLED: "false" });
    h = http(t);
  });
  afterAll(async () => {
    await t.app.get(JobQueues, { strict: false }).botReplies.obliterate({ force: true });
    await t.close();
  });

  it("queues nothing, so a deployment with no worker piles nothing up in Redis", async () => {
    const a = await t.signUp();
    const { chat } = await h.directWith(a, "Priya Anand");

    await h.send(a, chat.id, { text: "hello bot" }).expect(201);

    expect(await jobsOf(t)).toHaveLength(0);
    expect(await t.redis.keys(`${t.env.QUEUE_PREFIX}:bot-reply-pending:*`)).toHaveLength(0);
  });
});
