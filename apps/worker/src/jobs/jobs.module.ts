import { type DynamicModule, Module } from "@nestjs/common";

import { WORKER_ENV, type WorkerEnv } from "../config/env.js";
import { BotRepliesProcessor } from "./bot-replies.processor.js";
import { BotReplyHandler } from "./bot-reply.handler.js";
import { MaintenanceProcessor } from "./maintenance.processor.js";
import { MaintenanceScheduler } from "./maintenance.scheduler.js";
import { QueueDepth } from "./queue-depth.js";
import { ExpireGuests } from "./tasks/expire-guests.js";
import { ExpireStatuses } from "./tasks/expire-statuses.js";
import { SweepOrphanAttachments } from "./tasks/sweep-orphan-attachments.js";
import { SweepRefreshTokens } from "./tasks/sweep-refresh-tokens.js";

/** Everything the worker does besides answering probes. `CoreModule` is global, so its services are here already. */
@Module({})
export class JobsModule {
  static register(env: WorkerEnv): DynamicModule {
    return {
      module: JobsModule,
      providers: [
        { provide: WORKER_ENV, useValue: env },
        BotReplyHandler,
        BotRepliesProcessor,
        ExpireGuests,
        ExpireStatuses,
        SweepOrphanAttachments,
        SweepRefreshTokens,
        MaintenanceProcessor,
        MaintenanceScheduler,
        QueueDepth,
      ],
      exports: [BotReplyHandler, MaintenanceProcessor, MaintenanceScheduler],
    };
  }
}
