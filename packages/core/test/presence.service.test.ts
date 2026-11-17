import { randomUUID } from "node:crypto";

import type { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createTestRedis, type TestRedis } from "@dovetalk/testkit";

import { PresenceService } from "../src/realtime/presence.service.js";
import { createRedis } from "../src/redis.js";

// A fake clock: every call takes `now` explicitly, so nothing here waits for real time.
const TTL = 45_000;
const DEBOUNCE = 5000;
const T0 = 1_000_000;

let testRedis: TestRedis;
let redis: Redis;
let presence: PresenceService;

beforeAll(async () => {
  testRedis = await createTestRedis();
  redis = createRedis({ url: testRedis.url, name: "presence-test" });
  presence = new PresenceService(redis, {
    presence: { socketTtlMs: TTL, offlineDebounceMs: DEBOUNCE },
  } as never);
});
beforeEach(() => testRedis.flush());
afterAll(async () => {
  await testRedis.flush();
  await redis.quit();
});

const user = () => randomUUID();
const socket = () => randomUUID();

describe("PresenceService", () => {
  it("says a person came online only for their first connection", async () => {
    const u = user();
    expect(await presence.connect(u, socket(), T0)).toBe(true);
    expect(await presence.connect(u, socket(), T0 + 1)).toBe(false);
    expect(await presence.isOnline(u)).toBe(true);
  });

  it("keeps a person online while any connection is left", async () => {
    const u = user();
    const [a, b] = [socket(), socket()];
    await presence.connect(u, a, T0);
    await presence.connect(u, b, T0);
    await presence.disconnect([{ userId: u, socketId: a }], T0 + 100);
    // Long after the debounce: the other connection is still alive.
    expect(await presence.sweep(T0 + 100 + DEBOUNCE + 1)).toEqual([]);
    expect(await presence.isOnline(u)).toBe(true);
  });

  it("waits out the debounce before saying a person went offline, and says it once", async () => {
    const u = user();
    const s = socket();
    await presence.connect(u, s, T0);
    await presence.disconnect([{ userId: u, socketId: s }], T0 + 1000);

    expect(await presence.sweep(T0 + 1000 + DEBOUNCE - 1)).toEqual([]);
    expect(await presence.isOnline(u)).toBe(true);

    expect(await presence.sweep(T0 + 1000 + DEBOUNCE)).toEqual([u]);
    expect(await presence.isOnline(u)).toBe(false);
    expect(await presence.sweep(T0 + 1000 + DEBOUNCE + 10)).toEqual([]);
  });

  it("announces nothing when somebody reconnects inside the debounce (a page reload)", async () => {
    const u = user();
    const first = socket();
    await presence.connect(u, first, T0);
    await presence.disconnect([{ userId: u, socketId: first }], T0 + 1000);

    // The reload comes back, perhaps on another instance: not "online" again, they never left.
    expect(await presence.connect(u, socket(), T0 + 2000)).toBe(false);
    expect(await presence.sweep(T0 + 1000 + DEBOUNCE + 1)).toEqual([]);
    expect(await presence.isOnline(u)).toBe(true);
  });

  it("lets a connection of a crashed instance run out, without any disconnect", async () => {
    const u = user();
    await presence.connect(u, socket(), T0);

    expect(await presence.sweep(T0 + TTL - 1)).toEqual([]);
    expect(await presence.sweep(T0 + TTL + 1)).toEqual([u]);
    expect(await presence.isOnline(u)).toBe(false);
  });

  it("keeps a person online for as long as their heartbeats keep coming", async () => {
    const u = user();
    const s = socket();
    await presence.connect(u, s, T0);
    for (let beat = 1; beat <= 5; beat += 1) {
      const now = T0 + beat * 15_000;
      expect(await presence.heartbeat([{ userId: u, socketId: s }], now)).toEqual([]);
      expect(await presence.sweep(now)).toEqual([]);
    }
    expect(await presence.isOnline(u)).toBe(true);
  });

  it("brings back a person whose heartbeat was so late that they were swept", async () => {
    const u = user();
    const s = socket();
    await presence.connect(u, s, T0);
    expect(await presence.sweep(T0 + TTL + 1)).toEqual([u]);

    expect(await presence.heartbeat([{ userId: u, socketId: s }], T0 + TTL + 2)).toEqual([u]);
    expect(await presence.isOnline(u)).toBe(true);
  });

  it("returns each name to one caller when several sweep at once", async () => {
    const people = Array.from({ length: 20 }, user);
    await Promise.all(people.map((u) => presence.connect(u, socket(), T0)));

    const results = await Promise.all(
      Array.from({ length: 5 }, () => presence.sweep(T0 + TTL + 1, 100)),
    );
    const all = results.flat();
    expect(all).toHaveLength(people.length);
    expect(new Set(all)).toEqual(new Set(people));
  });

  it("sweeps in batches", async () => {
    const people = Array.from({ length: 7 }, user);
    await Promise.all(people.map((u) => presence.connect(u, socket(), T0)));
    const first = await presence.sweep(T0 + TTL + 1, 3);
    const second = await presence.sweep(T0 + TTL + 1, 3);
    const third = await presence.sweep(T0 + TTL + 1, 3);
    expect([first.length, second.length, third.length]).toEqual([3, 3, 1]);
  });

  it("looks up many people at once", async () => {
    const [a, b, c] = [user(), user(), user()];
    await presence.connect(a, socket(), T0);
    await presence.connect(c, socket(), T0);
    expect(await presence.onlineAmong([a, b, c, a])).toEqual(new Set([a, c]));
    expect(await presence.onlineAmong([])).toEqual(new Set());
  });

  it("forgets a person's connection keys after they expire, so Redis does not fill up", async () => {
    const u = user();
    await presence.connect(u, socket(), Date.now());
    const ttl = await redis.pttl(`presence:sockets:${u}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(TTL * 2);
  });
});
