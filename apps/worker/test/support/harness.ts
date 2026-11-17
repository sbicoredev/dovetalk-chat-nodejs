import { randomBytes } from "node:crypto";

import type { INestApplicationContext } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { sql } from "drizzle-orm";
import { vi } from "vitest";

import {
  ChatsService,
  ContactsService,
  CoreModule,
  DRIZZLE,
  JobQueues,
  MAINTENANCE_TASKS,
  MessagesService,
  OnboardingService,
  RealtimeEvents,
  RealtimePublisher,
  StorageService,
  storageOptionsFromEnv,
  UploadsService,
} from "@dovetalk/core";
import { createDatabase, type Database, runMigrations, schema, type UserRow } from "@dovetalk/db";
import {
  createTestDatabase,
  createTestRedis,
  getTestStorage,
  type TestDatabase,
} from "@dovetalk/testkit";

import { loadWorkerEnv, type WorkerEnv } from "../../src/config/env.js";
import { WorkerModule } from "../../src/worker.module.js";

const { users, contacts } = schema;

/** One migrated database, one Redis and one S3 bucket, and a queue prefix nobody else uses. */
export interface Infra {
  close: () => Promise<void>;
  database: TestDatabase;
  prefix: string;
  redisUrl: string;
  /** Empties the data tables, so one test's rows (an old file, an expired guest) are not another's. */
  reset: () => Promise<void>;
  storageEnv: Record<string, string>;
}

export async function createInfra(): Promise<Infra> {
  const database = await createTestDatabase();
  const handle = createDatabase({ url: database.url, poolMax: 2 });
  await runMigrations(handle.db, handle.pool);
  await handle.close();
  const redis = await createTestRedis();
  const storage = await getTestStorage();
  return {
    database,
    redisUrl: redis.url,
    reset: async () => {
      const handle = createDatabase({ url: database.url, poolMax: 1 });
      try {
        // Everything hangs off these three, so the rest follows (the migrations' own table stays).
        await handle.db.execute(sql`truncate table users, chats, attachments cascade`);
      } finally {
        await handle.close();
      }
    },
    storageEnv: storage.env,
    prefix: `t-${randomBytes(4).toString("hex")}`,
    close: async () => {
      await redis.flush();
      await database.drop();
    },
  };
}

/** The worker's environment against this infrastructure. Quick settings, and nothing runs on a timer unless a test asks. */
export const workerEnv = (infra: Infra, over: Record<string, string> = {}): WorkerEnv =>
  loadWorkerEnv({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: infra.database.url,
    REDIS_URL: infra.redisUrl,
    QUEUE_PREFIX: infra.prefix,
    ...infra.storageEnv,
    DATABASE_POOL_MAX: "4",
    WORKER_HEALTH_PORT: "0",
    WORKER_HEALTH_HOST: "127.0.0.1",
    // Housekeeping is called by hand in these tests. A week keeps it from running by itself.
    CLEANUP_GUESTS_EVERY_MS: "604800000",
    CLEANUP_STATUSES_EVERY_MS: "604800000",
    CLEANUP_ATTACHMENTS_EVERY_MS: "604800000",
    CLEANUP_TOKENS_EVERY_MS: "604800000",
    ...over,
  });

/** An event the worker would have sent to somebody's sockets. */
export interface SentEvent {
  event: string;
  payload: Record<string, unknown>;
  userId: string;
}

export interface RunningWorker {
  app: INestApplicationContext;
  /** Everything this worker sent to sockets, in order. */
  events: SentEvent[];
  /** Waits until everything announced so far has gone out. Announcing happens in the background. */
  flush: () => Promise<void>;
  /** A provider of the worker, wherever in its modules it lives. */
  get: <T>(token: abstract new (...args: never[]) => T) => T;
  /** Flushes, then forgets what was sent: what a test set up is not what it is checking. */
  quiet: () => Promise<void>;
  /** What this worker sent to one person, optionally of one kind. */
  sentTo: (userId: string, event?: string) => SentEvent[];
}

/**
 * A worker runs each housekeeping job once as it starts (the schedule's first occurrence is due
 * at once). Left alone, that run lands whenever it likes, in the middle of a test's own setup:
 * it would delete the expired guest a test has just made. So wait for those runs first; what is
 * left to run by itself is a week away.
 */
async function settleBootRuns(app: INestApplicationContext): Promise<void> {
  const { maintenance } = app.get(JobQueues, { strict: false });
  await eventually(
    async () => {
      const n = await maintenance.getJobCounts("active", "waiting", "completed", "failed");
      return (n.active ?? 0) + (n.waiting ?? 0) === 0 &&
        (n.completed ?? 0) + (n.failed ?? 0) >= MAINTENANCE_TASKS.length
        ? true
        : undefined;
    },
    { message: "The worker's first housekeeping runs did not finish." },
  );
}

/** Boots the real worker module. */
export async function startWorker(
  infra: Infra,
  over: Record<string, string> = {},
): Promise<RunningWorker> {
  const app = await NestFactory.createApplicationContext(
    WorkerModule.register(workerEnv(infra, over)),
    { logger: false },
  );
  await settleBootRuns(app);
  const events: SentEvent[] = [];
  vi.spyOn(app.get(RealtimePublisher), "emitToUser").mockImplementation(
    (userId: string, event: string, payload: unknown) => {
      events.push({ userId, event, payload: payload as Record<string, unknown> });
    },
  );
  const flush = () => app.get(RealtimeEvents).idle();
  return {
    app,
    events,
    flush,
    quiet: async () => {
      await flush();
      events.length = 0;
    },
    get: (token) => app.get(token, { strict: false }),
    sentTo: (userId, event) =>
      events.filter((e) => e.userId === userId && (!event || e.event === event)),
  };
}

/**
 * What the API is, as far as the worker cares: the shared services with bot replies switched on,
 * so a person's message adds the jobs. Nothing here processes a job.
 */
export async function startApiSide(infra: Infra): Promise<INestApplicationContext> {
  const env = workerEnv(infra);
  return NestFactory.createApplicationContext(
    CoreModule.forRoot({
      serviceName: "dovetalk-api-test",
      database: { url: env.DATABASE_URL, poolMax: 4 },
      redisUrl: env.REDIS_URL,
      jobs: { botReplies: true, prefix: infra.prefix },
      storage: storageOptionsFromEnv(env),
    }),
    { logger: false },
  );
}

/** The services a test needs from any running context, with the database handle. */
export function servicesOf(app: INestApplicationContext) {
  const db = app.get<Database>(DRIZZLE);
  return {
    db,
    chats: app.get(ChatsService),
    contacts: app.get(ContactsService),
    messages: app.get(MessagesService),
    onboarding: app.get(OnboardingService),
    queues: app.get(JobQueues),
    storage: app.get(StorageService),
    uploads: app.get(UploadsService),
  };
}

let counter = 0;
const unique = () => {
  counter += 1;
  return `${Date.now().toString(36)}${counter}${randomBytes(3).toString("hex")}`;
};

export async function makePerson(
  db: Database,
  over: Partial<typeof users.$inferInsert> = {},
): Promise<UserRow> {
  const [row] = await db
    .insert(users)
    .values({
      name: "Pat Person",
      hue: 20,
      email: `${unique()}@example.com`,
      passwordHash: "$argon2id$stub",
      ...over,
    })
    .returning();
  return row as UserRow;
}

export async function makeBot(
  db: Database,
  over: Partial<typeof users.$inferInsert> = {},
): Promise<UserRow> {
  const [row] = await db
    .insert(users)
    .values({ name: "Bo Bot", hue: 200, isBot: true, ...over })
    .returning();
  return row as UserRow;
}

/** An expired (or not yet expired) guest. */
export const makeGuest = (
  db: Database,
  expiresInMs: number,
  over: Partial<typeof users.$inferInsert> = {},
) =>
  makePerson(db, {
    name: "Guest Visitor",
    email: `guest-${unique()}@guest.dovetalk.invalid`,
    passwordHash: null,
    isGuest: true,
    guestExpiresAt: new Date(Date.now() + expiresInMs),
    ...over,
  });

/** `owner` knows each of `people`. Returns the contact ids in order. */
export async function befriend(db: Database, owner: UserRow, people: UserRow[]): Promise<string[]> {
  const rows = await db
    .insert(contacts)
    .values(people.map((p) => ({ ownerId: owner.id, linkedUserId: p.id, name: p.name })))
    .returning({ id: contacts.id, userId: contacts.linkedUserId });
  const byUser = new Map(rows.map((r) => [r.userId, r.id]));
  return people.map((p) => byUser.get(p.id) as string);
}

/** Waits until `check` passes. Polls, because the thing waited for is a job in another connection. */
export async function eventually<T>(
  check: () => Promise<T | false | undefined | null> | T | false | undefined | null,
  { timeoutMs = 10_000, message = "Timed out waiting." } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let result = await check();
  while (!result) {
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
    result = await check();
  }
  return result;
}

/** A file in object storage and its row, as an upload leaves them. `ageMs` backdates the row. */
export async function makeAttachment(
  db: Database,
  storage: StorageService,
  owner: UserRow,
  { ageMs = 0, mime = "text/plain", name = "note.txt" } = {},
) {
  const key = `uploads/${owner.id}/${unique()}`;
  await storage.put(key, new TextEncoder().encode("hello"), { mime, name });
  const [row] = await db
    .insert(schema.attachments)
    .values({
      ownerId: owner.id,
      storageKey: key,
      name,
      size: 5,
      mime,
      createdAt: new Date(Date.now() - ageMs),
    })
    .returning();
  return row as typeof schema.attachments.$inferSelect;
}

/** Whether the file is in object storage, asked of the store itself. */
export async function objectExists(file: { storageKey: string }): Promise<boolean> {
  return (await getTestStorage()).objectExists(file.storageKey);
}

/** A note. `expiresInMs` is negative for one that has expired. */
export async function makeStatus(db: Database, owner: UserRow, expiresInMs: number) {
  const day = 24 * 60 * 60 * 1000;
  const [row] = await db
    .insert(schema.statuses)
    .values({
      ownerId: owner.id,
      text: "hello",
      color: 0,
      createdAt: new Date(Date.now() + expiresInMs - day),
      expiresAt: new Date(Date.now() + expiresInMs),
    })
    .returning();
  return row as typeof schema.statuses.$inferSelect;
}

/** A refresh token row. Times are offsets from now in milliseconds. */
export async function makeToken(
  db: Database,
  owner: UserRow,
  {
    expiresInMs,
    rotatedAgoMs,
    revokedAgoMs,
  }: { expiresInMs: number; rotatedAgoMs?: number; revokedAgoMs?: number },
) {
  const [row] = await db
    .insert(schema.refreshTokens)
    .values({
      userId: owner.id,
      familyId: crypto.randomUUID(),
      tokenHash: unique(),
      expiresAt: new Date(Date.now() + expiresInMs),
      rotatedAt: rotatedAgoMs === undefined ? null : new Date(Date.now() - rotatedAgoMs),
      revokedAt: revokedAgoMs === undefined ? null : new Date(Date.now() - revokedAgoMs),
    })
    .returning();
  return row as typeof schema.refreshTokens.$inferSelect;
}
