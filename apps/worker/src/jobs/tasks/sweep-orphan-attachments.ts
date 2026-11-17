import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, lt, notExists, sql } from "drizzle-orm";

import { DRIZZLE, StorageService } from "@dovetalk/core";
import { type Database, schema } from "@dovetalk/db";

import { WORKER_ENV, type WorkerEnv } from "../../config/env.js";

const { attachments, messages, users } = schema;

const MAX_BATCHES = 100;

/**
 * Removes uploads that nothing came to use: no message and no profile photo points at them, and
 * they are older than `ORPHAN_ATTACHMENT_AGE_MS` (24 hours by default). The row and the file go.
 *
 * Why it can be trusted with people's files:
 * - The rows are picked `FOR UPDATE SKIP LOCKED`, and sending a message locks the attachment
 *   row before it claims it. So a send that is claiming a file right now is either seen (and the
 *   file is skipped) or waits until this batch is done and then fails with "attachment not
 *   found", which is the answer for a file this old anyway.
 * - The file is removed from storage before the row, in the same transaction. If storage fails,
 *   nothing is deleted and the next run tries again.
 */
@Injectable()
export class SweepOrphanAttachments {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
  ) {}

  async run(): Promise<{ attachments: number }> {
    const limit = this.env.CLEANUP_BATCH_SIZE;
    let total = 0;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each batch must commit before the next one looks for more.
      const removed = await this.batch(limit);
      total += removed;
      if (removed < limit) {
        break;
      }
    }
    return { attachments: total };
  }

  private batch(limit: number): Promise<number> {
    return this.db.transaction(async (tx) => {
      const orphans = await tx
        .select({ id: attachments.id, key: attachments.storageKey })
        .from(attachments)
        .where(
          and(
            lt(
              attachments.createdAt,
              sql`now() - ${this.env.ORPHAN_ATTACHMENT_AGE_MS} * interval '1 millisecond'`,
            ),
            notExists(
              tx
                .select({ one: messages.id })
                .from(messages)
                .where(eq(messages.attachmentId, attachments.id)),
            ),
            notExists(
              tx
                .select({ one: users.id })
                .from(users)
                .where(eq(users.avatarAttachmentId, attachments.id)),
            ),
          ),
        )
        .orderBy(asc(attachments.createdAt))
        .limit(limit)
        .for("update", { skipLocked: true, of: attachments });
      if (orphans.length === 0) {
        return 0;
      }
      await this.storage.delete(orphans.map((row) => row.key));
      await tx.delete(attachments).where(
        inArray(
          attachments.id,
          orphans.map((row) => row.id),
        ),
      );
      return orphans.length;
    });
  }
}
