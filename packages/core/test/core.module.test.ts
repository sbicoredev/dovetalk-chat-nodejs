import { Inject, Injectable } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Redis } from "ioredis";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createTestDatabase, createTestRedis, type TestDatabase } from "@dovetalk/testkit";

import {
  AttachmentsService,
  ChatsService,
  ContactsService,
  CoreModule,
  HealthChecks,
  MessageStore,
  MessagesService,
  OnboardingService,
  PG_POOL,
  Projector,
  REDIS,
  StorageService,
  UploadsService,
} from "../src/index.js";

/** Nothing connects to storage while the module is built, so the address need not exist. */
const storage = {
  endpoint: "http://localhost:8333",
  publicEndpoint: "http://localhost:8333",
  region: "us-east-1",
  bucket: "dovetalk-unit",
  accessKeyId: "key",
  secretAccessKey: "secret",
  forcePathStyle: true,
  createBucket: false,
};

let database: TestDatabase;
let redisUrl: string;

beforeAll(async () => {
  database = await createTestDatabase();
  redisUrl = (await createTestRedis()).url;
});
afterAll(() => database.drop());

const build = (overrides: { databaseUrl?: string; redisUrl?: string } = {}) =>
  Test.createTestingModule({
    imports: [
      CoreModule.forRoot({
        serviceName: "dovetalk-test",
        database: {
          url: overrides.databaseUrl ?? database.url,
          poolMax: 2,
          connectionTimeoutMs: 500,
        },
        redisUrl: overrides.redisUrl ?? redisUrl,
        storage,
      }),
    ],
  }).compile();

describe("CoreModule", () => {
  it("exports the conversation services to modules that import it", async () => {
    // A provider that is registered but not exported cannot be injected by a module that imports
    // CoreModule. This consumer is such a module's provider: compiling fails if one is missing.
    @Injectable()
    class Consumer {
      constructor(
        @Inject(Projector) readonly projector: Projector,
        @Inject(ContactsService) readonly contacts: ContactsService,
        @Inject(MessageStore) readonly store: MessageStore,
        @Inject(ChatsService) readonly chats: ChatsService,
        @Inject(MessagesService) readonly messages: MessagesService,
        @Inject(OnboardingService) readonly onboarding: OnboardingService,
        @Inject(StorageService) readonly storage: StorageService,
        @Inject(AttachmentsService) readonly attachments: AttachmentsService,
        @Inject(UploadsService) readonly uploads: UploadsService,
      ) {}
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        CoreModule.forRoot({
          serviceName: "dovetalk-test",
          database: { url: database.url, poolMax: 2, connectionTimeoutMs: 500 },
          redisUrl,
          storage,
        }),
      ],
      providers: [Consumer],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    const consumer = app.get(Consumer);
    expect(consumer.chats).toBeInstanceOf(ChatsService);
    expect(consumer.messages).toBeInstanceOf(MessagesService);
    expect(consumer.contacts).toBeInstanceOf(ContactsService);
    expect(consumer.onboarding).toBeInstanceOf(OnboardingService);
    expect(consumer.uploads).toBeInstanceOf(UploadsService);
    await app.close();
  });

  it("connects, reports ready, and closes its connections on shutdown", async () => {
    const moduleRef = await build();
    const app = moduleRef.createNestApplication();
    await app.init();

    const health = app.get(HealthChecks);
    const ready = await health.ready();
    expect(ready.ok).toBe(true);
    expect(ready.checks.database.ok).toBe(true);
    expect(ready.checks.cache.ok).toBe(true);

    const pool = app.get<pg.Pool>(PG_POOL);
    const redis = app.get<Redis>(REDIS);
    await app.close();
    expect(pool.ended).toBe(true);
    await vi.waitFor(() => expect(redis.status).toBe("end"));
  });

  it("stops reporting ready once shutdown begins", async () => {
    const app = (await build()).createNestApplication();
    await app.init();
    const health = app.get(HealthChecks);
    health.shutdown.begin();
    const ready = await health.ready();
    expect(ready).toMatchObject({ ok: false, draining: true });
    await app.close();
  });

  it("fails fast, not hangs, when a dependency is down", async () => {
    const app = (
      await build({ databaseUrl: "postgres://pgtest@localhost:1/none" })
    ).createNestApplication();
    await app.init();
    const started = Date.now();
    const result = await app.get(HealthChecks).database(1000);
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2500);
    await app.close();
  });
});
