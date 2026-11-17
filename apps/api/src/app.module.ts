import { type DynamicModule, Module } from "@nestjs/common";

import { CoreModule, createLoggerModule, storageOptionsFromEnv } from "@dovetalk/core";

import { AuthModule } from "./auth/auth.module.js";
import { ChatsModule } from "./chats/chats.module.js";
import { CommonModule } from "./common/common.module.js";
import { API_ENV, type ApiEnv } from "./config/env.js";
import { ContactsModule } from "./contacts/contacts.module.js";
import { HealthModule } from "./health/health.module.js";
import { MeModule } from "./me/me.module.js";
import { MessagesModule } from "./messages/messages.module.js";
import { RealtimeModule } from "./realtime/realtime.module.js";
import { StatusesModule } from "./statuses/statuses.module.js";
import { UploadsModule } from "./uploads/uploads.module.js";

export const SERVICE_NAME = "dovetalk-api";

@Module({})
export class AppModule {
  static register(env: ApiEnv): DynamicModule {
    return {
      module: AppModule,
      global: true,
      imports: [
        createLoggerModule({ ...env, serviceName: SERVICE_NAME }),
        CoreModule.forRoot({
          serviceName: SERVICE_NAME,
          database: {
            url: env.DATABASE_URL,
            poolMax: env.DATABASE_POOL_MAX,
            statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
          },
          redisUrl: env.REDIS_URL,
          jobs: { botReplies: env.BOT_REPLIES_ENABLED, prefix: env.QUEUE_PREFIX },
          presence: {
            socketTtlMs: env.PRESENCE_SOCKET_TTL_MS,
            offlineDebounceMs: env.PRESENCE_OFFLINE_DEBOUNCE_MS,
          },
          storage: storageOptionsFromEnv(env),
        }),
        CommonModule,
        AuthModule,
        MeModule,
        ContactsModule,
        ChatsModule,
        MessagesModule,
        StatusesModule,
        UploadsModule,
        RealtimeModule,
        HealthModule,
      ],
      providers: [{ provide: API_ENV, useValue: env }],
      exports: [API_ENV],
    };
  }
}
