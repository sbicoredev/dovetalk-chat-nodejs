import { Inject, Injectable } from "@nestjs/common";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  notExists,
  notInArray,
  or,
  sql,
} from "drizzle-orm";

import { DRIZZLE, StorageService } from "@dovetalk/core";
import { type Database, schema, type Transaction } from "@dovetalk/db";

import { WORKER_ENV, type WorkerEnv } from "../../config/env.js";

const { attachments, chatMembers, chats, messages, users } = schema;

export interface ExpireGuestsResult {
  chats: number;
  /** Files deleted, row and object. */
  files: number;
  guests: number;
  /** Files handed over to a real person who forwarded them, and so kept. */
  kept: number;
}

const NOTHING: ExpireGuestsResult = { guests: 0, chats: 0, files: 0, kept: 0 };

/** A run stops after this many batches, so one backlog cannot hold a worker for ever. The next run carries on. */
const MAX_BATCHES = 50;

/**
 * Deletes guest accounts whose 24 hours are up, and everything that was theirs.
 *
 * The database does most of it: deleting the user cascades to their sessions, contacts, chat
 * memberships, messages, files, notes and the ghost contacts they made. Two things it cannot do:
 *
 * - Remove the files from object storage. They are removed first, in the same transaction, so a
 *   storage failure rolls the batch back and the next run tries again with every row still there.
 *   (The other order would lose the keys, and the files with them.)
 * - Remove the chats nobody is left in. A guest's chats with the shared bots would stay for ever
 *   with a bot as the only member. A chat with a real person still in it stays.
 *
 * One thing the cascade would get wrong, so it is handled first: a forward shares the original's
 * file, and the forward is the forwarder's message. A guest's file that somebody staying has
 * forwarded is handed to them (the earliest forwarder, when there are several) instead of being
 * deleted, so the copy they sent keeps its attachment. The guest's own message goes with them.
 *
 * Safe to run on several workers at once (`FOR UPDATE SKIP LOCKED`) and safe to run twice.
 */
@Injectable()
export class ExpireGuests {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
  ) {}

  async run(): Promise<ExpireGuestsResult> {
    const total: ExpireGuestsResult = { ...NOTHING };
    const limit = this.env.CLEANUP_BATCH_SIZE;
    for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: each batch must commit before the next one looks for more.
      const done = await this.batch(limit);
      total.guests += done.guests;
      total.chats += done.chats;
      total.files += done.files;
      total.kept += done.kept;
      if (done.guests < limit) {
        break;
      }
    }
    return total;
  }

  private batch(limit: number): Promise<ExpireGuestsResult> {
    return this.db.transaction(async (tx) => {
      const expired = await tx
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.isGuest, true), lte(users.guestExpiresAt, sql`now()`)))
        .orderBy(asc(users.guestExpiresAt), asc(users.id))
        .limit(limit)
        .for("update", { skipLocked: true });
      if (expired.length === 0) {
        return { ...NOTHING };
      }
      const guestIds = expired.map((row) => row.id);

      // Whoever goes with them: the ghosts they made (deleted by the cascade) are members of
      // their chats too, and the ghosts' files, if they ever had any, are theirs.
      const ghosts = await tx
        .select({ id: users.id })
        .from(users)
        .where(inArray(users.ghostOwnerId, guestIds));
      const leaving = [...guestIds, ...ghosts.map((row) => row.id)];

      // Before the files to delete are chosen: what is handed over is no longer theirs.
      const kept = await this.handOverForwardedFiles(tx, leaving);

      const [rooms, files] = await Promise.all([
        tx
          .selectDistinct({ id: chatMembers.chatId })
          .from(chatMembers)
          .where(inArray(chatMembers.userId, leaving)),
        tx
          .select({ key: attachments.storageKey })
          .from(attachments)
          .where(inArray(attachments.ownerId, leaving)),
      ]);

      await this.storage.delete(files.map((file) => file.key));
      await tx.delete(users).where(inArray(users.id, guestIds));

      const emptied =
        rooms.length === 0
          ? []
          : await tx
              .delete(chats)
              .where(
                and(
                  inArray(
                    chats.id,
                    rooms.map((room) => room.id),
                  ),
                  notExists(
                    tx
                      .select({ one: chatMembers.userId })
                      .from(chatMembers)
                      .innerJoin(users, eq(users.id, chatMembers.userId))
                      .where(
                        and(
                          eq(chatMembers.chatId, chats.id),
                          eq(users.isBot, false),
                          isNull(chatMembers.leftAt),
                        ),
                      ),
                  ),
                ),
              )
              .returning({ id: chats.id });
      return { guests: guestIds.length, chats: emptied.length, files: files.length, kept };
    });
  }

  /**
   * Gives each file of `leaving` users that a message of somebody staying still uses to the
   * earliest such sender (message ids are UUIDv7, so the lowest id is the first one sent), and
   * returns how many files that was. Somebody staying is not one of `leaving`, and not a guest
   * whose own time is up either: that file would only be deleted by their batch.
   */
  private async handOverForwardedFiles(tx: Transaction, leaving: string[]): Promise<number> {
    const heirs = await tx
      .selectDistinctOn([messages.attachmentId], {
        fileId: messages.attachmentId,
        heirId: messages.senderId,
      })
      .from(messages)
      .innerJoin(attachments, eq(attachments.id, messages.attachmentId))
      .innerJoin(users, eq(users.id, messages.senderId))
      .where(
        and(
          inArray(attachments.ownerId, leaving),
          notInArray(messages.senderId, leaving),
          or(
            eq(users.isGuest, false),
            isNull(users.guestExpiresAt),
            gt(users.guestExpiresAt, sql`now()`),
          ),
        ),
      )
      .orderBy(asc(messages.attachmentId), asc(messages.id));

    const byHeir = new Map<string, string[]>();
    for (const { fileId, heirId } of heirs) {
      if (fileId && heirId) {
        byHeir.set(heirId, [...(byHeir.get(heirId) ?? []), fileId]);
      }
    }
    await Promise.all(
      [...byHeir].map(([heirId, fileIds]) =>
        tx.update(attachments).set({ ownerId: heirId }).where(inArray(attachments.id, fileIds)),
      ),
    );
    return heirs.length;
  }
}
