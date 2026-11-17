import { Inject, Injectable, Logger, type OnApplicationShutdown } from "@nestjs/common";
import { type ConnectionOptions, type JobsOptions, Queue } from "bullmq";

import type { CoreOptions } from "../core.options.js";
import { CORE_OPTIONS } from "../tokens.js";
import {
  BOT_REPLIES_QUEUE,
  type BotReplyJobData,
  MAINTENANCE_QUEUE,
  type MaintenanceTask,
} from "./names.js";

/** The default prefix of every Redis key BullMQ makes. Tests use their own, so suites never share a queue. */
export const DEFAULT_QUEUE_PREFIX = "dovetalk";

/** Settings every job gets unless it says otherwise. */
export const BOT_JOB_DEFAULTS: JobsOptions = {
  // A reply that fails is tried again with growing pauses, and then kept in the failed set
  // (the dead-letter store) for a week so somebody can look at it.
  attempts: 5,
  backoff: { type: "exponential", delay: 1000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
};

export const MAINTENANCE_JOB_DEFAULTS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 30_000 },
  removeOnComplete: { age: 24 * 3600, count: 100 },
  removeOnFail: { age: 7 * 24 * 3600, count: 1000 },
};

/**
 * BullMQ talks to Redis over connections of its own. A worker's blocking connection must never
 * give up on a command, which the general-purpose connection (three retries, then an error, so
 * an outage shows up as errors and not as hung requests) does. So BullMQ gets its own settings.
 */
export const queueConnection = (redisUrl: string, name: string): ConnectionOptions => ({
  url: redisUrl,
  connectionName: name,
  maxRetriesPerRequest: null,
  enableReadyCheck: true,
  retryStrategy: (attempt: number) => Math.min(attempt * 200, 5000),
});

/**
 * Owns the queues the API and the worker both talk to. The API only adds to them, the worker
 * processes them (its processors make their own `Worker`s on the same names and prefix).
 *
 * Queues connect when first used, so a process that never queues anything opens nothing.
 */
@Injectable()
export class JobQueues implements OnApplicationShutdown {
  private readonly logger = new Logger("JobQueues");
  private bots?: Queue<BotReplyJobData>;
  private upkeep?: Queue<Record<string, never>, unknown, MaintenanceTask>;

  constructor(@Inject(CORE_OPTIONS) private readonly options: CoreOptions) {}

  get prefix(): string {
    return this.options.jobs?.prefix ?? DEFAULT_QUEUE_PREFIX;
  }

  /** Connection settings for a `Worker` that reads these queues. */
  connection(name: string): ConnectionOptions {
    return queueConnection(this.options.redisUrl, name);
  }

  get botReplies(): Queue<BotReplyJobData> {
    this.bots ??= this.open(
      new Queue<BotReplyJobData>(BOT_REPLIES_QUEUE, {
        connection: this.connection(`${this.options.serviceName}:queue:${BOT_REPLIES_QUEUE}`),
        prefix: this.prefix,
        defaultJobOptions: BOT_JOB_DEFAULTS,
      }),
    );
    return this.bots;
  }

  get maintenance(): Queue<Record<string, never>, unknown, MaintenanceTask> {
    this.upkeep ??= this.open(
      new Queue<Record<string, never>, unknown, MaintenanceTask>(MAINTENANCE_QUEUE, {
        connection: this.connection(`${this.options.serviceName}:queue:${MAINTENANCE_QUEUE}`),
        prefix: this.prefix,
        defaultJobOptions: MAINTENANCE_JOB_DEFAULTS,
      }),
    );
    return this.upkeep;
  }

  private open<
    Q extends { name: string; on: (event: "error", listener: (error: Error) => void) => unknown },
  >(queue: Q): Q {
    // Without a listener an "error" event would crash the process. BullMQ reconnects by itself.
    queue.on("error", (error) => this.logger.error(`Queue ${queue.name}: ${error.message}`));
    return queue;
  }

  async onApplicationShutdown(): Promise<void> {
    const queues = [this.bots, this.upkeep].filter((queue) => queue !== undefined);
    await Promise.allSettled(queues.map((queue) => queue.close()));
  }
}
