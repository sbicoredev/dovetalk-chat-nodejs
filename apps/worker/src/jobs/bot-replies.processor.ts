import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnModuleInit,
} from "@nestjs/common";
import type { Worker } from "bullmq";

import {
  BOT_REPLIES_QUEUE,
  BOT_REPLY_JOB,
  BOT_TYPING_JOB,
  type BotReplyJobData,
  JobQueues,
  RealtimeEvents,
} from "@dovetalk/core";
import { dovetalkMetrics } from "@dovetalk/telemetry";

import { WORKER_ENV, type WorkerEnv } from "../config/env.js";
import { BotReplyHandler } from "./bot-reply.handler.js";
import { runWorker } from "./run-worker.js";

type BotJobName = typeof BOT_TYPING_JOB | typeof BOT_REPLY_JOB;

/**
 * Runs the bot-reply queue: for each message a person sends a bot, a "typing" job after about
 * 700 ms and a "reply" job after about 2.4 s (both added by the API, `BotReplyScheduler`).
 *
 * On shutdown it stops taking jobs and waits for the ones running, before the database and Redis
 * close (`beforeApplicationShutdown` runs ahead of `onApplicationShutdown`, where core closes them).
 * A delayed job that has not started stays in Redis, and a worker started later runs it, so a
 * restart loses no reply.
 */
@Injectable()
export class BotRepliesProcessor implements OnModuleInit, BeforeApplicationShutdown {
  private worker?: Worker<BotReplyJobData, unknown, BotJobName>;

  constructor(
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @Inject(JobQueues) private readonly queues: JobQueues,
    @Inject(BotReplyHandler) private readonly handler: BotReplyHandler,
    @Inject(RealtimeEvents) private readonly events: RealtimeEvents,
  ) {}

  async onModuleInit(): Promise<void> {
    this.worker = runWorker<BotReplyJobData, BotJobName>({
      queue: BOT_REPLIES_QUEUE,
      prefix: this.queues.prefix,
      connection: this.queues.connection(`dovetalk-worker:${BOT_REPLIES_QUEUE}`),
      concurrency: this.env.BOT_REPLY_CONCURRENCY,
      process: async (job) => {
        if (job.name === BOT_TYPING_JOB) {
          return this.handler.typing(job.data);
        }
        const startedAt = performance.now();
        const outcome = await this.handler.reply(job.data);
        dovetalkMetrics().botReplyDuration.record(performance.now() - startedAt, { outcome });
        return outcome;
      },
      onDeadLetter: async (job) => {
        // Only the reply's end matters: it lets the chat answer again.
        if (job.name === BOT_REPLY_JOB) {
          await this.handler.giveUp(job.data);
        }
      },
    });
    // Resolves when the connection is up, so a bad Redis URL fails the start and not the first job.
    await this.worker.waitUntilReady();
  }

  async beforeApplicationShutdown(): Promise<void> {
    // Waits for jobs that are running to finish.
    await this.worker?.close();
    // What those jobs announced (typing, the new message) has to leave before Redis closes.
    await this.events.idle();
  }
}
