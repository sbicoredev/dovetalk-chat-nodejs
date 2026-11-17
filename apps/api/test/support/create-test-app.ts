import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { NestExpressApplication } from "@nestjs/platform-express";
import type { Redis } from "ioredis";
import request from "supertest";

import type { MeDto, RegisterInput } from "@dovetalk/contracts";
import { DRIZZLE, REDIS } from "@dovetalk/core";
import { createDatabase, type Database, runMigrations } from "@dovetalk/db";
import {
  createTestDatabase,
  createTestRedis,
  getTestStorage,
  type TestDatabase,
} from "@dovetalk/testkit";

import { createApp } from "../../src/bootstrap.js";
import { type ApiEnv, loadApiEnv } from "../../src/config/env.js";

export const TEST_ORIGIN = "http://localhost:3000";
export const TEST_PASSWORD = "correct horse battery";

const HIGH = "100000";

/** A running API instance that sockets can connect to. */
export interface TestInstance {
  app: NestExpressApplication;
  close: () => Promise<void>;
  /** For example http://127.0.0.1:41234 */
  url: string;
}

export interface TestApp {
  app: NestExpressApplication;
  close: () => Promise<void>;
  database: TestDatabase;
  db: Database;
  env: ApiEnv;
  /** Makes this app listen on a free port (once) and returns where sockets can reach it. */
  listen: () => Promise<string>;
  redis: Redis;
  server: Server;
  /** Registers a new person with a unique email and returns everything needed to act as them. */
  signUp: (overrides?: Partial<RegisterInput>) => Promise<TestAccount>;
  /**
   * Starts another instance of the same API: same database, same Redis, same secrets, its own
   * process-level state. Closed with the app. This is what a second replica behind a load balancer is.
   */
  startInstance: () => Promise<TestInstance>;
}

export interface TestAccount {
  accessToken: string;
  bearer: { Authorization: string };
  email: string;
  password: string;
  /** The raw refresh token from the Set-Cookie header. */
  refreshToken: string;
  user: MeDto;
}

/**
 * Boots the whole API against a fresh, migrated database and Redis, the way production does.
 * Rate limits are very high unless a test overrides them, so ordinary tests never trip them,
 * and the auth cache is off, so a deleted user is noticed straight away.
 */
export async function createTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const database = await createTestDatabase();
  const redisHandle = await createTestRedis();
  const testStorage = await getTestStorage();

  const migrator = createDatabase({ url: database.url, poolMax: 2 });
  await runMigrations(migrator.db, migrator.pool);
  await migrator.close();

  const apiEnv = loadApiEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: database.url,
    REDIS_URL: redisHandle.url,
    ...testStorage.env,
    DATABASE_POOL_MAX: "5",
    // No bot answers unless a test turns them on: nothing here runs a worker, and a queued reply
    // would only sit in Redis. Every app gets queues of its own.
    BOT_REPLIES_ENABLED: "false",
    QUEUE_PREFIX: `t-${Math.random().toString(36).slice(2, 10)}`,
    // Quick presence, so a test waits for tenths of a second instead of half a minute.
    PRESENCE_HEARTBEAT_MS: "250",
    PRESENCE_SOCKET_TTL_MS: "1500",
    PRESENCE_OFFLINE_DEBOUNCE_MS: "400",
    PRESENCE_SWEEP_MS: "100",
    CORS_ORIGINS: TEST_ORIGIN,
    JWT_SECRET: "test-secret-test-secret-test-secret-0123456789",
    AUTH_CACHE_TTL_MS: "0",
    RATE_LIMIT_GLOBAL: HIGH,
    RATE_LIMIT_LOGIN_IP: HIGH,
    RATE_LIMIT_LOGIN_EMAIL: HIGH,
    RATE_LIMIT_REGISTER: HIGH,
    RATE_LIMIT_GUEST: HIGH,
    RATE_LIMIT_REFRESH: HIGH,
    ...env,
  });
  const app = await createApp(apiEnv);
  await app.init();
  const server = app.getHttpServer() as Server;

  const instances: TestInstance[] = [];
  const urlOf = (running: NestExpressApplication) =>
    `http://127.0.0.1:${((running.getHttpServer() as Server).address() as AddressInfo).port}`;
  let listening: Promise<string> | null = null;
  const listen = () => {
    listening ??= app.listen(0, "127.0.0.1").then(() => urlOf(app));
    return listening;
  };
  const startInstance: TestApp["startInstance"] = async () => {
    const other = await createApp(apiEnv);
    await other.init();
    await other.listen(0, "127.0.0.1");
    const instance: TestInstance = {
      app: other,
      url: urlOf(other),
      close: () => other.close(),
    };
    instances.push(instance);
    return instance;
  };

  let counter = 0;
  const signUp: TestApp["signUp"] = async (overrides = {}) => {
    counter += 1;
    const input: RegisterInput = {
      email: `person${counter}-${Math.random().toString(36).slice(2, 8)}@example.com`,
      password: TEST_PASSWORD,
      name: "Test Person",
      ...overrides,
    };
    const res = await request(server).post("/auth/register").send(input).expect(201);
    return {
      email: input.email.trim().toLowerCase(),
      password: input.password,
      accessToken: res.body.accessToken,
      user: res.body.user,
      refreshToken: refreshTokenFrom(res.headers["set-cookie"])!,
      bearer: { Authorization: `Bearer ${res.body.accessToken}` },
    };
  };

  return {
    app,
    env: apiEnv,
    server,
    db: app.get<Database>(DRIZZLE),
    redis: app.get<Redis>(REDIS),
    database,
    signUp,
    listen,
    startInstance,
    async close() {
      await Promise.allSettled(instances.map((instance) => instance.close()));
      await app.close();
      await database.drop();
    },
  };
}

/** The raw `Set-Cookie` header values, as supertest gives them. */
export function setCookies(header: string | string[] | undefined): string[] {
  if (header === undefined) {
    return [];
  }
  return Array.isArray(header) ? header : [header];
}

/** The refresh token a response set, or undefined if it did not set one (or cleared it). */
export function refreshTokenFrom(header: string | string[] | undefined): string | undefined {
  const line = setCookies(header).find((c) => c.startsWith("dt_refresh="));
  const value = line?.split(";")[0]?.slice("dt_refresh=".length);
  return value || undefined;
}

export const refreshCookie = (token: string) => `dt_refresh=${token}`;
