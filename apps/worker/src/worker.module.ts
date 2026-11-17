import { type DynamicModule, Module } from "@nestjs/common";

import { CoreModule, createLoggerModule, storageOptionsFromEnv } from "@dovetalk/core";

import { WORKER_ENV, type WorkerEnv } from "./config/env.js";
import { HealthServer } from "./health-server.js";
import { JobsModule } from "./jobs/jobs.module.js";

export const SERVICE_NAME = "dovetalk-worker";

@Module({})
export class WorkerModule {
  /** The job processors (bot replies and housekeeping) live in `JobsModule`. */
  static register(env: WorkerEnv): DynamicModule {
    return {
      module: WorkerModule,
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
          // The worker sends the bots' replies. They must not set more replies going.
          jobs: { botReplies: false, prefix: env.QUEUE_PREFIX },
          storage: storageOptionsFromEnv(env),
        }),
        JobsModule.register(env),
      ],
      providers: [{ provide: WORKER_ENV, useValue: env }, HealthServer],
    };
  }
}
