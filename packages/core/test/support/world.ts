import type { Redis } from "ioredis";

import {
  createDatabase,
  type Database,
  type DatabaseHandle,
  type MessageRow,
  newId,
  runMigrations,
  schema,
  type UserRow,
} from "@dovetalk/db";
import {
  createTestDatabase,
  createTestRedis,
  getTestStorage,
  type TestDatabase,
} from "@dovetalk/testkit";

import { ChatsService } from "../../src/conversations/chats.service.js";
import { ContactsService } from "../../src/conversations/contacts.service.js";
import { type AppendMessage, MessageStore } from "../../src/conversations/message-store.js";
import { MessagesService } from "../../src/conversations/messages.service.js";
import { Projector } from "../../src/conversations/projector.js";
import { StatusesService } from "../../src/conversations/statuses.service.js";
import type { CoreOptions } from "../../src/core.options.js";
import { BotReplyScheduler } from "../../src/jobs/bot-reply-scheduler.js";
import { JobQueues } from "../../src/jobs/job-queues.js";
import { OnboardingService } from "../../src/onboarding/onboarding.service.js";
import { PresenceService } from "../../src/realtime/presence.service.js";
import { RealtimePublisher } from "../../src/realtime/realtime.publisher.js";
import { RealtimeEvents } from "../../src/realtime/realtime-events.service.js";
import { createRedis } from "../../src/redis.js";
import { AttachmentsService } from "../../src/storage/attachments.service.js";
import { StorageService } from "../../src/storage/storage.service.js";
import { UploadsService } from "../../src/storage/uploads.service.js";

const { users, contacts } = schema;

/** One event that would have gone to a person's sockets. */
export interface SentEvent {
  event: string;
  payload: unknown;
  userId: string;
}

/**
 * A publisher that remembers what it was asked to send instead of sending it, so a test can say
 * exactly who was told what. The real one is covered through the API, with real sockets.
 */
class RecordingPublisher extends RealtimePublisher {
  readonly sent: SentEvent[] = [];

  override emitToUser(userId: string, event: string, payload: unknown): void {
    this.sent.push({ userId, event, payload });
  }
}

/** A migrated database of its own, the services on top of it, and helpers to make people. */
export interface World {
  attachments: AttachmentsService;
  /** Saved contacts for `owner` for each of `people`, in one statement. Returns the contact ids in order. */
  befriend: (owner: UserRow, people: UserRow[]) => Promise<string[]>;
  /** A shared bot, like the seeded ones. */
  bot: (over?: Partial<typeof users.$inferInsert>) => Promise<UserRow>;
  /** Sets bots answering. Only does anything in a world made with `botReplies: true`. */
  botReplies: BotReplyScheduler;
  chats: ChatsService;
  close: () => Promise<void>;
  contacts: ContactsService;
  db: Database;
  /** Announces changes. Everything it sends is recorded in `sent`. Call `settle()` before reading `sent`. */
  events: RealtimeEvents;
  handle: DatabaseHandle;
  messages: MessagesService;
  onboarding: OnboardingService;
  /** `count` people who can sign in, in one statement. */
  people: (count: number) => Promise<UserRow[]>;
  presence: PresenceService;
  projector: Projector;
  /** The queues the scheduler adds to. A world has its own prefix, so no other test sees them. */
  queues: JobQueues;
  redis: Redis;
  /** Appends a message the way sending will, in its own transaction. */
  say: (
    chatId: string,
    senderId: string | null,
    text: string,
    over?: Partial<AppendMessage>,
  ) => Promise<MessageRow>;
  /** What `events` has sent so far, in order. */
  sent: SentEvent[];
  /** The events sent to one person, optionally of one kind. */
  sentTo: (userId: string, event?: string) => SentEvent[];
  /** Waits until every announcement asked for so far has been made. */
  settle: () => Promise<void>;
  statuses: StatusesService;
  storage: StorageService;
  store: MessageStore;
  uploads: UploadsService;
  /** A person who can sign in. */
  user: (over?: Partial<typeof users.$inferInsert>) => Promise<UserRow>;
}

/** Where a world's storage points when a test does not use it. Nothing connects until it is used. */
const UNUSED_STORAGE = {
  endpoint: "http://127.0.0.1:9",
  publicEndpoint: "http://127.0.0.1:9",
  region: "us-east-1",
  bucket: "unused",
  accessKeyId: "unused",
  secretAccessKey: "unused",
  forcePathStyle: true,
  createBucket: false,
};

export interface WorldOptions {
  /** Turn on the jobs that make a bot answer. Off by default, so no test leaves jobs in Redis. */
  botReplies?: boolean;
  /** Start (or reach) a real S3 server for this world. Off by default: most tests never store a file. */
  storage?: boolean;
}

export async function createWorld(options: WorldOptions = {}): Promise<World> {
  const testDb: TestDatabase = await createTestDatabase();
  const handle = createDatabase({ url: testDb.url, poolMax: 8 });
  await runMigrations(handle.db, handle.pool);
  const { db } = handle;

  const projector = new Projector();
  const testRedis = await createTestRedis();
  const coreOptions: CoreOptions = {
    serviceName: "test",
    database: { url: testDb.url },
    redisUrl: testRedis.url,
    storage: options.storage ? (await getTestStorage()).options : UNUSED_STORAGE,
    jobs: { botReplies: options.botReplies ?? false, prefix: `t-${newId()}` },
  };
  const storage = new StorageService(coreOptions);
  const attachments = new AttachmentsService(db, storage);
  const redis = createRedis({ url: testRedis.url, name: "core-test" });
  const queues = new JobQueues(coreOptions);
  const botReplies = new BotReplyScheduler(db, redis, queues, coreOptions);
  const publisher = new RecordingPublisher(redis);
  const presence = new PresenceService(redis);
  const events = new RealtimeEvents(db, projector, attachments, publisher, presence);
  const contactsService = new ContactsService(db, projector, attachments, presence, events);
  const store = new MessageStore();
  const chats = new ChatsService(db, projector, contactsService, store, attachments, events);
  const messages = new MessagesService(db, projector, store, attachments, events, botReplies);
  const statuses = new StatusesService(db, events);
  const onboarding = new OnboardingService(db);
  const uploads = new UploadsService(db, storage, attachments);

  const insertUser = async (values: Partial<typeof users.$inferInsert>) => {
    const [row] = await db
      .insert(users)
      .values({ name: "Test Person", hue: 10, ...values })
      .returning();
    return row!;
  };
  const credentials = () => ({ email: `${newId()}@example.com`, passwordHash: "$argon2id$stub" });

  return {
    db,
    handle,
    events,
    presence,
    redis,
    settle: () => events.idle(),
    sent: publisher.sent,
    sentTo: (userId, event) =>
      publisher.sent.filter((s) => s.userId === userId && (!event || s.event === event)),
    projector,
    contacts: contactsService,
    store,
    chats,
    messages,
    statuses,
    onboarding,
    storage,
    attachments,
    uploads,
    botReplies,
    queues,
    user: (over = {}) => insertUser({ ...credentials(), ...over }),
    bot: (over = {}) => insertUser({ isBot: true, ...over }),
    people: (count) =>
      db
        .insert(users)
        .values(
          Array.from({ length: count }, (_, i) => ({
            ...credentials(),
            name: `Person${i} Test`,
            hue: i % 360,
          })),
        )
        .returning(),
    async befriend(owner, people) {
      if (people.length === 0) {
        return [];
      }
      const rows = await db
        .insert(contacts)
        .values(
          people.map((person) => ({
            ownerId: owner.id,
            linkedUserId: person.id,
            name: person.name,
          })),
        )
        .returning({ id: contacts.id, userId: contacts.linkedUserId });
      const byUser = new Map(rows.map((row) => [row.userId, row.id]));
      return people.map((person) => byUser.get(person.id)!);
    },
    say: (chatId, senderId, text, over = {}) =>
      db.transaction((tx) => store.append(tx, { chatId, senderId, kind: "text", text, ...over })),
    async close() {
      await events.idle();
      await botReplies.idle();
      if (options.botReplies) {
        await queues.botReplies.obliterate({ force: true });
      }
      await queues.onApplicationShutdown();
      await redis.quit();
      await testRedis.flush();
      await handle.close();
      await testDb.drop();
    },
  };
}
