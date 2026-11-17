import { Inject, Injectable } from "@nestjs/common";
import { inArray, lte, sql } from "drizzle-orm";

import { DRIZZLE } from "@dovetalk/core";
import { type Database, schema } from "@dovetalk/db";

import { WORKER_ENV, type WorkerEnv } from "../../config/env.js";

const { statuses } = schema;

const MAX_BATCHES = 100;

/**
 * Deletes notes whose 24 hours are up (their views go with them). Readers already hide an expired
 * note by the database clock, so this only keeps the table from growing: a note vanishes for people
 * the moment it expires, whenever this job runs.
 */
@Injectable()
export class ExpireStatuses {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
  ) {}

  async run(): Promise<{ statuses: number }> {
    const limit = this.env.CLEANUP_BATCH_SIZE;
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each batch must commit before the next one looks for more.
      const gone = await this.db
        .delete(statuses)
        .where(
          inArray(
            statuses.id,
            this.db
              .select({ id: statuses.id })
              .from(statuses)
              .where(lte(statuses.expiresAt, sql`now()`))
              .limit(limit)
              .for("update", { skipLocked: true }),
          ),
        )
        .returning({ id: statuses.id });
      total += gone.length;
      if (gone.length < limit) {
        break;
      }
    }
    return { statuses: total };
  }
}
