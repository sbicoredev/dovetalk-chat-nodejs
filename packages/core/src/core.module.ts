import {
  type DynamicModule,
  Inject,
  Injectable,
  Logger,
  Module,
  type OnApplicationShutdown,
} from "@nestjs/common";
import type { Redis } from "ioredis";

import { createDatabase, type DatabaseHandle } from "@dovetalk/db";

import { ChatsService } from "./conversations/chats.service.js";
import { ContactsService } from "./conversations/contacts.service.js";
import { MessageStore } from "./conversations/message-store.js";
import { MessagesService } from "./conversations/messages.service.js";
import { Projector } from "./conversations/projector.js";
import { StatusesService } from "./conversations/statuses.service.js";
import type { CoreOptions } from "./core.options.js";
import { HealthChecks, ShutdownState } from "./health.js";
import { BotReplyScheduler } from "./jobs/bot-reply-scheduler.js";
import { JobQueues } from "./jobs/job-queues.js";
import { OnboardingService } from "./onboarding/onboarding.service.js";
import { PoolMetrics } from "./pool-metrics.js";
import { PresenceService } from "./realtime/presence.service.js";
import { RealtimePublisher } from "./realtime/realtime.publisher.js";
import { RealtimeEvents } from "./realtime/realtime-events.service.js";
import { createRedis } from "./redis.js";
import { AttachmentsService } from "./storage/attachments.service.js";
import { StorageService } from "./storage/storage.service.js";
import { UploadsService } from "./storage/uploads.service.js";
import { CORE_OPTIONS, DATABASE_HANDLE, DRIZZLE, PG_POOL, REDIS } from "./tokens.js";

/** Closes the connections when the app stops, after the HTTP server has stopped taking requests. */
@Injectable()
class CoreLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger("Core");

  constructor(
    @Inject(DATABASE_HANDLE) private readonly database: DatabaseHandle,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async onApplicationShutdown() {
    await Promise.allSettled([
      this.database.close(),
      this.redis.quit().catch(() => this.redis.disconnect()),
    ]);
    this.logger.log("Closed database and Redis connections.");
  }
}

/**
 * Infrastructure both apps need: Postgres through Drizzle, a Redis connection and health
 * checks. Domain services join this module as they are built.
 */
@Module({})
export class CoreModule {
  static forRoot(options: CoreOptions): DynamicModule {
    return {
      module: CoreModule,
      global: true,
      providers: [
        { provide: CORE_OPTIONS, useValue: options },
        {
          provide: DATABASE_HANDLE,
          useFactory: (): DatabaseHandle => {
            const logger = new Logger("Database");
            return createDatabase({
              ...options.database,
              applicationName: options.serviceName,
              onPoolError: (error) => logger.error(`Idle connection failed: ${error.message}`),
            });
          },
        },
        {
          provide: DRIZZLE,
          useFactory: (handle: DatabaseHandle) => handle.db,
          inject: [DATABASE_HANDLE],
        },
        {
          provide: PG_POOL,
          useFactory: (handle: DatabaseHandle) => handle.pool,
          inject: [DATABASE_HANDLE],
        },
        {
          provide: REDIS,
          useFactory: () => {
            const logger = new Logger("Redis");
            return createRedis({
              url: options.redisUrl,
              name: options.serviceName,
              onError: (error) => logger.error(error.message),
            });
          },
        },
        ShutdownState,
        HealthChecks,
        Projector,
        RealtimePublisher,
        PresenceService,
        RealtimeEvents,
        ContactsService,
        MessageStore,
        ChatsService,
        MessagesService,
        StatusesService,
        OnboardingService,
        StorageService,
        AttachmentsService,
        UploadsService,
        JobQueues,
        BotReplyScheduler,
        PoolMetrics,
        CoreLifecycle,
      ],
      exports: [
        DATABASE_HANDLE,
        DRIZZLE,
        PG_POOL,
        REDIS,
        ShutdownState,
        HealthChecks,
        Projector,
        RealtimePublisher,
        PresenceService,
        RealtimeEvents,
        ContactsService,
        MessageStore,
        ChatsService,
        MessagesService,
        StatusesService,
        OnboardingService,
        StorageService,
        AttachmentsService,
        UploadsService,
        JobQueues,
        BotReplyScheduler,
      ],
    };
  }
}
