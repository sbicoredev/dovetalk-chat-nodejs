import { Inject, Injectable, Logger, type OnModuleInit } from "@nestjs/common";

import { JobQueues, MAINTENANCE_TASKS, type MaintenanceTask } from "@dovetalk/core";

import { WORKER_ENV, type WorkerEnv } from "../config/env.js";

/** How often each housekeeping job repeats, from the environment. */
export const scheduleOf = (env: WorkerEnv): Record<MaintenanceTask, number> => ({
  "expire-guests": env.CLEANUP_GUESTS_EVERY_MS,
  "expire-statuses": env.CLEANUP_STATUSES_EVERY_MS,
  "sweep-orphan-attachments": env.CLEANUP_ATTACHMENTS_EVERY_MS,
  "sweep-refresh-tokens": env.CLEANUP_TOKENS_EVERY_MS,
});

/**
 * Registers the repeating jobs when the worker starts. `upsertJobScheduler` is an upsert: every
 * replica does this on every start, and Redis ends up with one schedule per job, with the newest
 * settings. A job that runs every N minutes runs once per period across all replicas, not once
 * per replica, because the schedule lives in Redis and a worker takes each occurrence once.
 */
@Injectable()
export class MaintenanceScheduler implements OnModuleInit {
  private readonly logger = new Logger("Maintenance");

  constructor(
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
    @Inject(JobQueues) private readonly queues: JobQueues,
  ) {}

  async onModuleInit(): Promise<void> {
    const schedule = scheduleOf(this.env);
    for (const task of MAINTENANCE_TASKS) {
      // biome-ignore lint/performance/noAwaitInLoops: four small writes, and a clear order in the log.
      await this.queues.maintenance.upsertJobScheduler(
        task,
        { every: schedule[task] },
        { name: task, data: {} },
      );
    }
    this.logger.log({ every: schedule }, "Scheduled the housekeeping jobs");
  }
}
