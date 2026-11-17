import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ContactDto } from "@dovetalk/contracts";
import { RealtimeEvents } from "@dovetalk/core";

import { createTestApp, type TestAccount, type TestApp } from "./support/create-test-app.js";
import { makePeople } from "./support/people.js";
import { connect, sleep, type TestSocket, until } from "./support/sockets.js";

let t: TestApp;
let url: string;
const opened: TestSocket[] = [];

beforeAll(async () => {
  t = await createTestApp();
  url = await t.listen();
});
afterAll(async () => {
  for (const socket of opened) {
    socket.close();
  }
  await t.close();
});

const open = async (who: TestAccount) => {
  const socket = await connect(url, who);
  opened.push(socket);
  return socket;
};

/** Long enough for the debounce (400 ms here) and a few sweeps to have run. */
const pastDebounce = () => sleep(1200);

const pair = async () => {
  const people = await makePeople(t, 2);
  const [ann, ben] = people.accounts as [TestAccount, TestAccount];
  return { ...people, ann, ben };
};

/** What `viewer`'s contact list says about `other` right now. */
const listedOnline = async (
  h: Awaited<ReturnType<typeof pair>>["h"],
  viewer: TestAccount,
  contactId: string,
) => {
  const list = (await h.as(viewer).get("/contacts").expect(200)).body as ContactDto[];
  return list.find((c) => c.id === contactId)?.online;
};

const presenceOf = (socket: TestSocket, contactId: string) =>
  socket.heard("presence").filter((p) => p.contactId === contactId);

describe("presence", () => {
  it("tells people who have somebody as a contact when they come online and go offline, under their own contact id", async () => {
    const { ann, ben, contactOf } = await pair();
    const benSocket = await open(ben);
    const asBenSeesAnn = contactOf(ben, ann).id;

    const annSocket = await open(ann);
    await benSocket.waitFor("presence", (p) => p.contactId === asBenSeesAnn && p.online);

    annSocket.close();
    await benSocket.waitFor("presence", (p) => p.contactId === asBenSeesAnn && !p.online);
    expect(presenceOf(benSocket, asBenSeesAnn).map((p) => p.online)).toEqual([true, false]);
  });

  it("is shown in GET /contacts as online while connected, and not after", async () => {
    const { ann, ben, contactOf, h } = await pair();
    const asBenSeesAnn = contactOf(ben, ann).id;
    expect(await listedOnline(h, ben, asBenSeesAnn)).toBe(false);

    const annSocket = await open(ann);
    await until(
      async () => (await listedOnline(h, ben, asBenSeesAnn)) === true,
      "not shown online",
    );
    annSocket.close();
    await until(
      async () => (await listedOnline(h, ben, asBenSeesAnn)) === false,
      "still shown online",
      6000,
    );
  });

  it("announces nothing when somebody reloads inside the debounce", async () => {
    const { ann, ben, contactOf, h } = await pair();
    const asBenSeesAnn = contactOf(ben, ann).id;
    const benSocket = await open(ben);
    const first = await open(ann);
    await benSocket.waitFor("presence", (p) => p.contactId === asBenSeesAnn && p.online);

    first.close();
    await sleep(100); // A reload: gone for a moment, well inside the 400 ms debounce.
    const second = await open(ann);
    await pastDebounce();

    expect(presenceOf(benSocket, asBenSeesAnn).map((p) => p.online)).toEqual([true]);
    expect(await listedOnline(h, ben, asBenSeesAnn)).toBe(true);
    second.close();
  });

  it("keeps somebody online while one of two devices is still connected", async () => {
    const { ann, ben, contactOf, h } = await pair();
    const asBenSeesAnn = contactOf(ben, ann).id;
    const benSocket = await open(ben);
    const laptop = await open(ann);
    const phone = await open(ann);
    await benSocket.waitFor("presence", (p) => p.contactId === asBenSeesAnn && p.online);

    laptop.close();
    await pastDebounce();
    expect(presenceOf(benSocket, asBenSeesAnn).map((p) => p.online)).toEqual([true]);
    expect(await listedOnline(h, ben, asBenSeesAnn)).toBe(true);

    phone.close();
    await benSocket.waitFor("presence", (p) => p.contactId === asBenSeesAnn && !p.online);
    expect(await listedOnline(h, ben, asBenSeesAnn)).toBe(false);
  });

  it("stays online past the connection lifetime while the heartbeat keeps it alive", async () => {
    const { ann, ben, contactOf, h } = await pair();
    const asBenSeesAnn = contactOf(ben, ann).id;
    const benSocket = await open(ben);
    const annSocket = await open(ann);
    await benSocket.waitFor("presence", (p) => p.contactId === asBenSeesAnn && p.online);

    // Three times the 1.5 s lifetime used in tests.
    await sleep(4500);
    expect(presenceOf(benSocket, asBenSeesAnn).map((p) => p.online)).toEqual([true]);
    expect(await listedOnline(h, ben, asBenSeesAnn)).toBe(true);
    annSocket.close();
  });

  it("does not tell people who do not have the person as a contact", async () => {
    const { ann } = await pair();
    const stranger = await t.signUp({ name: "Stranger" });
    const strangerSocket = await open(stranger);
    await open(ann);
    await pastDebounce();
    expect(strangerSocket.heard("presence")).toEqual([]);
  });
});

describe("presence and blocking", () => {
  it("shows a blocked pair as offline to each other, and gives the real state back on unblock", async () => {
    const { ann, ben, contactOf, h } = await pair();
    const asBenSeesAnn = contactOf(ben, ann).id;
    const asAnnSeesBen = contactOf(ann, ben).id;
    const benSocket = await open(ben);
    const annSocket = await open(ann);
    await benSocket.waitFor("presence", (p) => p.contactId === asBenSeesAnn && p.online);

    await h.as(ben).put(`/contacts/${asBenSeesAnn}/block`).send({ blocked: true }).expect(200);
    // Both are told the other went offline, and the list agrees with the events.
    await benSocket.waitFor("presence", (p) => p.contactId === asBenSeesAnn && !p.online);
    await annSocket.waitFor("presence", (p) => p.contactId === asAnnSeesBen && !p.online);
    expect(await listedOnline(h, ben, asBenSeesAnn)).toBe(false);
    expect(await listedOnline(h, ann, asAnnSeesBen)).toBe(false);

    await h.as(ben).put(`/contacts/${asBenSeesAnn}/block`).send({ blocked: false }).expect(200);
    await t.app.get(RealtimeEvents).idle();
    await until(
      () => presenceOf(benSocket, asBenSeesAnn).at(-1)?.online === true,
      "Ben was not told Ann is online again",
    );
    await until(
      () => presenceOf(annSocket, asAnnSeesBen).at(-1)?.online === true,
      "Ann was not told Ben is online again",
    );
    expect(await listedOnline(h, ben, asBenSeesAnn)).toBe(true);
  });

  it("never announces somebody online to a person they are blocked by or have blocked", async () => {
    const { ann, ben, contactOf, h } = await pair();
    const asBenSeesAnn = contactOf(ben, ann).id;
    await h.as(ben).put(`/contacts/${asBenSeesAnn}/block`).send({ blocked: true }).expect(200);
    const benSocket = await open(ben);

    const annSocket = await open(ann);
    await sleep(300);
    annSocket.close();
    await pastDebounce();
    expect(presenceOf(benSocket, asBenSeesAnn).filter((p) => p.online)).toEqual([]);
  });
});
