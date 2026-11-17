import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";

import { JobQueues } from "@dovetalk/core";
import { observeGauge } from "@dovetalk/telemetry";

const STATES = ["waiting", "active", "delayed", "failed"] as const;

/**
 * Reports how many jobs sit in each queue and state, read when metrics are collected:
 * `queue_jobs{queue, state}`. Every worker replica reports the same numbers, because the counts
 * live in Redis, so a dashboard takes the `max` over replicas, not the sum.
 *
 * The collection waits for Redis, so a slow Redis shows up as a missing point and not as a
 * hung export: a failed read is logged and skipped.
 *
 * The gauge is removed when the app stops, so it does not keep reading a closed queue.
 */
@Injectable()
export class QueueDepth implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("QueueDepth");
  private stop: (() => void) | undefined;

  constructor(@Inject(JobQueues) private readonly queues: JobQueues) {}

  onModuleInit(): void {
    this.stop = observeGauge(
      "queue_jobs",
      "Jobs in each queue, by state. Report the max over worker replicas.",
      async () => {
        const named = [this.queues.botReplies, this.queues.maintenance];
        const counts = await Promise.all(
          named.map(async (queue) => ({
            queue: queue.name,
            counts: await queue.getJobCounts(...STATES),
          })),
        );
        return counts.flatMap(({ queue, counts: byState }) =>
          STATES.map((state) => ({ value: byState[state] ?? 0, attributes: { queue, state } })),
        );
      },
      (error) =>
        this.logger.warn(
          `Could not read the queue sizes: ${error instanceof Error ? error.message : String(error)}`,
        ),
    );
  }

  onModuleDestroy(): void {
    this.stop?.();
    this.stop = undefined;
  }
}
