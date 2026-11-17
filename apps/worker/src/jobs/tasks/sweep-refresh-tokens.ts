import { Inject, Injectable } from "@nestjs/common";
import { and, inArray, isNotNull, lt, or, sql } from "drizzle-orm";

import { DRIZZLE } from "@dovetalk/core";
import { type Database, schema } from "@dovetalk/db";

import { WORKER_ENV, type WorkerEnv } from "../../config/env.js";

const { refreshTokens } = schema;

const MAX_BATCHES = 100;

/**
 * Deletes refresh tokens that can no longer do anything: expired ones, and ones that were
 * revoked more than a day ago.
 *
 * It deliberately keeps a token that was only *rotated*, until it expires. Presenting a rotated
 * token again is how a stolen copy is noticed (the whole sign-in is revoked, see refresh tokens in docs/API.md), and that
 * needs the row. A revoked token needs nothing: using it is a 401, exactly like an unknown one.
 */
@Injectable()
export class SweepRefreshTokens {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
  ) {}

  async run(): Promise<{ tokens: number }> {
    const limit = this.env.CLEANUP_BATCH_SIZE;
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each batch must commit before the next one looks for more.
      const gone = await this.db
        .delete(refreshTokens)
        .where(
          inArray(
            refreshTokens.id,
            this.db
              .select({ id: refreshTokens.id })
              .from(refreshTokens)
              .where(
                or(
                  lt(refreshTokens.expiresAt, sql`now()`),
                  and(
                    isNotNull(refreshTokens.revokedAt),
                    lt(refreshTokens.revokedAt, sql`now() - interval '1 day'`),
                  ),
                ),
              )
              .limit(limit)
              .for("update", { skipLocked: true }),
          ),
        )
        .returning({ id: refreshTokens.id });
      total += gone.length;
      if (gone.length < limit) {
        break;
      }
    }
    return { tokens: total };
  }
}
