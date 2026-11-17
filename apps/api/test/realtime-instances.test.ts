import { Redis } from "ioredis";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { MessageDto } from "@dovetalk/contracts";
import { PresenceService, RealtimeEvents, RealtimePublisher } from "@dovetalk/core";

import {
  createTestApp,
  type TestAccount,
  type TestApp,
  type TestInstance,
} from "./support/create-test-app.js";
import { makePeople } from "./support/people.js";
import { connect, sleep, type TestSocket, until } from "./support/sockets.js";

/**
 * Several API instances behind one load balancer, as in production: each its own Nest app with
 * its own connections, all sharing Postgres and Redis. A person can be connected to any of them.
 */
let t: TestApp;
let a: TestInstance;
let b: TestInstance;
const opened: TestSocket[] = [];
const clients: Redis[] = [];

beforeAll(async () => {
  t = await createTestApp();
  a = await t.startInstance();
  b = await t.startInstance();
});
afterAll(async () => {
  for (const socket of opened) {
    socket.close();
  }
  await Promise.allSettled(clients.map((client) => client.quit()));
  await t.close();
});

const open = async (instance: { url: string }, who: TestAccount) => {
  const socket = await connect(instance.url, who);
  opened.push(socket);
  return socket;
};

const pastDebounce = () => sleep(1200);

const people = async (count: number) => {
  const world = await makePeople(t, count);
  return { ...world, accounts: world.accounts };
};

/** Sends through one particular instance, the way a load balancer would route a request. */
const sendVia = async (instance: { url: string }, who: TestAccount, chatId: string, text: string) =>
  (
    await request(instance.url)
      .post(`/chats/${chatId}/messages`)
      .set(who.bearer)
      .send({ clientId: crypto.randomUUID(), kind: "text", text })
      .expect(201)
  ).body as MessageDto;

describe("events across instances", () => {
  it("a message sent through one instance reaches a socket on the other, and the other way round", async () => {
    const { accounts, contactOf, direct } = await people(2);
    const [ann, ben] = accounts as [TestAccount, TestAccount];
    const chat = await direct(ann, ben);
    const annOnA = await open(a, ann);
    const benOnB = await open(b, ben);

    const toBen = await sendVia(a, ann, chat.id, "from A to B");
    const heard = await benOnB.waitFor("message:new", (p) => p.message.id === toBen.id);
    expect(heard.message.senderId).toBe(contactOf(ben, ann).id);
    await benOnB.waitFor("chat:updated", (p) => p.chat.id === chat.id && p.chat.unread === 1);
    // The sender's own socket, on the instance that took the request, hears it too.
    await annOnA.waitFor("message:new", (p) => p.message.id === toBen.id);

    const toAnn = await sendVia(b, ben, chat.id, "from B to A");
    const back = await annOnA.waitFor("message:new", (p) => p.message.id === toAnn.id);
    expect(back.message.senderId).toBe(contactOf(ann, ben).id);
  });

  it("each device of one person gets the event on whichever instance it is connected to, once", async () => {
    const { accounts, direct } = await people(2);
    const [ann, ben] = accounts as [TestAccount, TestAccount];
    const chat = await direct(ann, ben);
    const laptop = await open(a, ben);
    const phone = await open(b, ben);

    const sent = await sendVia(a, ann, chat.id, "to both devices");
    await laptop.waitFor("message:new", (p) => p.message.id === sent.id);
    await phone.waitFor("message:new", (p) => p.message.id === sent.id);
    await t.app.get(RealtimeEvents).idle();
    await sleep(150);
    for (const device of [laptop, phone]) {
      expect(device.heard("message:new").filter((p) => p.message.id === sent.id)).toHaveLength(1);
    }
  });

  it("typing crosses instances", async () => {
    const { accounts, contactOf, direct, h } = await people(2);
    const [ann, ben] = accounts as [TestAccount, TestAccount];
    const chat = await direct(ann, ben);
    await h.say(ann, chat.id, "hi");
    const annOnA = await open(a, ann);
    const benOnB = await open(b, ben);

    annOnA.socket.emit("typing", { chatId: chat.id, isTyping: true });
    const heard = await benOnB.waitFor("typing", (p) => p.chatId === chat.id && p.isTyping);
    expect(heard.contactId).toBe(contactOf(ben, ann).id);
  });

  it("presence crosses instances", async () => {
    const { accounts, contactOf } = await people(2);
    const [ann, ben] = accounts as [TestAccount, TestAccount];
    const asBenSeesAnn = contactOf(ben, ann).id;
    const benOnB = await open(b, ben);

    const annOnA = await open(a, ann);
    await benOnB.waitFor("presence", (p) => p.contactId === asBenSeesAnn && p.online);
    annOnA.close();
    await benOnB.waitFor("presence", (p) => p.contactId === asBenSeesAnn && !p.online);
    // One announcement each way, even though every instance sweeps.
    expect(benOnB.heard("presence").map((p) => p.online)).toEqual([true, false]);
  });

  it("a publish from a standalone publisher, as the worker makes, reaches a socket on any instance", async () => {
    const { accounts, contactOf } = await people(2);
    const [ann, ben] = accounts as [TestAccount, TestAccount];
    const benOnB = await open(b, ben);
    const benOnA = await open(a, ben);

    // Nothing here is a Nest app or a socket server: just a Redis connection and the publisher.
    const redis = new Redis(t.env.REDIS_URL);
    clients.push(redis);
    const publisher = new RealtimePublisher(redis);
    const payload = {
      chatId: "0198f9a5-0000-7000-8000-000000000001",
      contactId: contactOf(ben, ann).id,
      name: "Bot",
      isTyping: true,
    };
    publisher.emitToUser(ben.user.id, "typing", payload);
    await publisher.flush();

    expect(await benOnB.waitFor("typing")).toEqual(payload);
    expect(await benOnA.waitFor("typing")).toEqual(payload);
    expect(publisher.failedCount).toBe(0);
  });
});

describe("instances coming and going", () => {
  it("closing an instance leaves a person connected to another one online, and clients can go to the other", async () => {
    const { accounts, contactOf, direct, h } = await people(3);
    const [ann, ben, cy] = accounts as [TestAccount, TestAccount, TestAccount];
    const leaving = await t.startInstance();
    const staying = await t.startInstance();
    const asBenSeesAnn = contactOf(ben, ann).id;
    const chat = await direct(cy, ben);
    await h.say(cy, chat.id, "hi"); // The chat reaches Ben's list with the first message.
    const watcher = await open(staying, ben);
    await open(leaving, ann);
    await open(staying, ann);
    const cyOnLeaving = await open(leaving, cy);
    await watcher.waitFor("presence", (p) => p.contactId === asBenSeesAnn && p.online);
    let dropped = false;
    cyOnLeaving.socket.on("disconnect", () => {
      dropped = true;
    });

    await leaving.close();

    // Its sockets were closed, so a client knows to go elsewhere.
    await until(() => dropped, "a client of the closed instance was not disconnected");
    // Ann is still on the other instance: nobody is told she left.
    await pastDebounce();
    expect(
      watcher.heard("presence").filter((p) => p.contactId === asBenSeesAnn && !p.online),
    ).toEqual([]);

    // Cy reconnects to the instance that is left and gets what is sent from now on.
    const cyAgain = await open(staying, cy);
    const sent = await sendVia(staying, ben, chat.id, "still here");
    await cyAgain.waitFor("message:new", (p) => p.message.id === sent.id);
  });

  it("closing an instance releases the people only it held, who are announced offline after the debounce", async () => {
    const { accounts, contactOf } = await people(2);
    const [ann, ben] = accounts as [TestAccount, TestAccount];
    const leaving = await t.startInstance();
    const asBenSeesAnn = contactOf(ben, ann).id;
    const watcher = await open(b, ben);
    await open(leaving, ann);
    await watcher.waitFor("presence", (p) => p.contactId === asBenSeesAnn && p.online);

    const closedAt = Date.now();
    await leaving.close();
    await watcher.waitFor("presence", (p) => p.contactId === asBenSeesAnn && !p.online);
    // Released at once rather than left to run out the connection lifetime (1.5 s in tests).
    expect(Date.now() - closedAt).toBeLessThan(1400);
  });

  it("a crashed instance's people are announced offline by another instance's sweep", async () => {
    const { accounts, contactOf, h } = await people(2);
    const [ann, ben] = accounts as [TestAccount, TestAccount];
    const crashed = await t.startInstance();
    const asBenSeesAnn = contactOf(ben, ann).id;
    const watcher = await open(b, ben);
    await open(crashed, ann);
    await watcher.waitFor("presence", (p) => p.contactId === asBenSeesAnn && p.online);

    // The crashed instance does no more work: no heartbeats, no sweeping. Its socket looks open
    // from outside, as a dead process's would to a load balancer for a while.
    const presence = crashed.app.get(PresenceService);
    vi.spyOn(presence, "heartbeat").mockResolvedValue([]);
    vi.spyOn(presence, "sweep").mockResolvedValue([]);

    await watcher.waitFor("presence", (p) => p.contactId === asBenSeesAnn && !p.online, 8000);
    expect(watcher.heard("presence").map((p) => p.online)).toEqual([true, false]);
    const list = (await h.as(ben).get("/contacts").expect(200)).body as {
      id: string;
      online: boolean;
    }[];
    expect(list.find((c) => c.id === asBenSeesAnn)?.online).toBe(false);
  });
});
