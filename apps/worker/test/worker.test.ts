import { NestFactory } from "@nestjs/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { JobQueues, MAINTENANCE_TASKS, PG_POOL, REDIS } from "@dovetalk/core";
import { createDatabase, runMigrations } from "@dovetalk/db";
import {
  createTestDatabase,
  createTestRedis,
  getTestStorage,
  type TestDatabase,
} from "@dovetalk/testkit";

import { loadWorkerEnv } from "../src/config/env.js";
import { HealthServer } from "../src/health-server.js";
import { WorkerModule } from "../src/worker.module.js";

let database: TestDatabase;
let redisUrl: string;
let storageEnv: Record<string, string>;
/** Its own queues: nothing another suite scheduled counts here, and nothing here leaks out. */
const prefix = `t-worker-${Math.random().toString(36).slice(2, 10)}`;

beforeAll(async () => {
  database = await createTestDatabase();
  // The housekeeping jobs read real tables, so the worker is started against a migrated database.
  const handle = createDatabase({ url: database.url, poolMax: 2 });
  await runMigrations(handle.db, handle.pool);
  await handle.close();
  redisUrl = (await createTestRedis()).url;
  storageEnv = (await getTestStorage()).env;
});
afterAll(() => database.drop());

const env = () =>
  loadWorkerEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: database.url,
    REDIS_URL: redisUrl,
    QUEUE_PREFIX: prefix,
    ...storageEnv,
    DATABASE_POOL_MAX: "2",
    WORKER_HEALTH_PORT: "0",
    WORKER_HEALTH_HOST: "127.0.0.1",
  });

describe("worker", () => {
  it("boots, connects, answers probes and shuts down cleanly", async () => {
    const app = await NestFactory.createApplicationContext(WorkerModule.register(env()), {
      logger: false,
    });
    const base = `http://127.0.0.1:${app.get(HealthServer).port}`;

    const live = await fetch(`${base}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toMatchObject({ status: "ok" });

    const ready = await fetch(`${base}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      status: "ok",
      checks: { database: { ok: true }, cache: { ok: true } },
    });

    expect((await fetch(`${base}/nope`)).status).toBe(404);

    // The housekeeping schedule is registered at start: one per task, nothing else.
    const schedulers = await app.get(JobQueues).maintenance.getJobSchedulers();
    expect(schedulers.map((scheduler) => scheduler.key).sort((a, b) => a.localeCompare(b))).toEqual(
      [...MAINTENANCE_TASKS].sort((a, b) => a.localeCompare(b)),
    );

    const pool = app.get<{ ended: boolean }>(PG_POOL);
    const redis = app.get<{ status: string }>(REDIS);
    await app.close();

    expect(pool.ended).toBe(true);
    await expect(fetch(`${base}/health/live`)).rejects.toThrow();
    await vi.waitFor(() => expect(redis.status).toBe("end"));
  });

  it("refuses to start when its health port is taken", async () => {
    const first = await NestFactory.createApplicationContext(WorkerModule.register(env()), {
      logger: false,
    });
    const taken = first.get(HealthServer).port;
    const clash = { ...env(), WORKER_HEALTH_PORT: taken };
    await expect(
      NestFactory.createApplicationContext(WorkerModule.register(clash), { logger: false }),
    ).rejects.toThrow(/EADDRINUSE/u);
    await first.close();
  });
});
