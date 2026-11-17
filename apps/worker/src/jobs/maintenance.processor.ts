import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnModuleInit,
} from "@nestjs/common";
import type { Worker } from "bullmq";

import { JobQueues, MAINTENANCE_QUEUE, type MaintenanceTask } from "@dovetalk/core";

import { runWorker } from "./run-worker.js";
import { ExpireGuests } from "./tasks/expire-guests.js";
import { ExpireStatuses } from "./tasks/expire-statuses.js";
import { SweepOrphanAttachments } from "./tasks/sweep-orphan-attachments.js";
import { SweepRefreshTokens } from "./tasks/sweep-refresh-tokens.js";

type NoData = Record<string, never>;

/** Runs the housekeeping jobs that `MaintenanceScheduler` repeats. */
@Injectable()
export class MaintenanceProcessor implements OnModuleInit, BeforeApplicationShutdown {
  private worker?: Worker<NoData, unknown, MaintenanceTask>;

  constructor(
    @Inject(JobQueues) private readonly queues: JobQueues,
    @Inject(ExpireGuests) private readonly guests: ExpireGuests,
    @Inject(ExpireStatuses) private readonly statuses: ExpireStatuses,
    @Inject(SweepOrphanAttachments) private readonly orphans: SweepOrphanAttachments,
    @Inject(SweepRefreshTokens) private readonly tokens: SweepRefreshTokens,
  ) {}

  /** Runs one task now, in this process. The queue's job does exactly this. */
  async run(task: MaintenanceTask): Promise<unknown> {
    switch (task) {
      case "expire-guests":
        return this.guests.run();
      case "expire-statuses":
        return this.statuses.run();
      case "sweep-orphan-attachments":
        return this.orphans.run();
      case "sweep-refresh-tokens":
        return this.tokens.run();
      default:
        throw new Error(`Unknown maintenance job: ${String(task)}`);
    }
  }

  async onModuleInit(): Promise<void> {
    this.worker = runWorker<NoData, MaintenanceTask>({
      queue: MAINTENANCE_QUEUE,
      prefix: this.queues.prefix,
      connection: this.queues.connection(`dovetalk-worker:${MAINTENANCE_QUEUE}`),
      // One at a time: they are housekeeping, and a large guest cleanup should not crowd the pool.
      concurrency: 1,
      process: (job) => this.run(job.name),
    });
    await this.worker.waitUntilReady();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.worker?.close();
  }
}
