import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, inArray, notExists } from "drizzle-orm";

import type { AttachmentDto } from "@dovetalk/contracts";
import { type AttachmentRow, type Database, type Executor, schema } from "@dovetalk/db";

import { DomainError } from "../errors.js";
import { DRIZZLE } from "../tokens.js";
import { isRasterImage } from "./file-info.js";
import { StorageService } from "./storage.service.js";

const { attachments, messages, users } = schema;

/** The row the API shows, with a link the browser can load. */
export const toAttachmentDto = (row: AttachmentRow, url: string): AttachmentDto => ({
  id: row.id,
  url,
  name: row.name,
  size: row.size,
  mime: row.mime,
  width: row.width,
  height: row.height,
});

/**
 * Reads attachments as DTOs and lets files go once nothing uses them. A file is used while a
 * message or a profile photo points at it; a forward shares the original's file, so deleting one
 * message must not take the file from the other (docs/edge-cases.md, #13).
 */
@Injectable()
export class AttachmentsService {
  private readonly logger = new Logger("Attachments");

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

  /** The rows with these ids, by id. Ids that do not exist are left out. */
  async rows(executor: Executor, ids: Iterable<string>): Promise<Map<string, AttachmentRow>> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) {
      return new Map();
    }
    const found = await executor.select().from(attachments).where(inArray(attachments.id, wanted));
    return new Map(found.map((row) => [row.id, row]));
  }

  /** The attachments with these ids as DTOs, by id. Ids that do not exist are left out. */
  async load(executor: Executor, ids: Iterable<string>): Promise<Map<string, AttachmentDto>> {
    return this.sign([...(await this.rows(executor, ids)).values()]);
  }

  /** Only the signed links, by attachment id. For profile photos, which are shown as a bare URL. */
  async urls(executor: Executor, ids: Iterable<string>): Promise<Map<string, string>> {
    const signed = await this.load(executor, ids);
    return new Map([...signed].map(([id, dto]) => [id, dto.url]));
  }

  /**
   * The picture a profile photo link points at. The link must be one of ours, the file must be
   * the person's own upload, and it must be a picture a browser draws. Anything else is a 422,
   * with one message for all of it, so the answer tells nobody which part was wrong.
   */
  async avatarFromLink(executor: Executor, ownerId: string, link: string): Promise<AttachmentRow> {
    const key = this.storage.keyFromLink(link);
    const [row] = key
      ? await executor
          .select()
          .from(attachments)
          .where(and(eq(attachments.storageKey, key), eq(attachments.ownerId, ownerId)))
          .limit(1)
      : [];
    if (!(row && isRasterImage(row.mime))) {
      throw new DomainError("VALIDATION_ERROR", ["That image can't be used as a profile photo."]);
    }
    return row;
  }

  /** Signs the given rows. One `now`, so every link in a response is the same hour's. */
  async sign(rows: readonly AttachmentRow[]): Promise<Map<string, AttachmentDto>> {
    const now = Date.now();
    const entries = await Promise.all(
      rows.map(
        async (row) =>
          [
            row.id,
            toAttachmentDto(row, await this.storage.signedUrl(row.storageKey, row, now)),
          ] as const,
      ),
    );
    return new Map(entries);
  }

  async dtoOf(row: AttachmentRow): Promise<AttachmentDto> {
    return toAttachmentDto(row, await this.storage.signedUrl(row.storageKey, row));
  }

  /**
   * Deletes the attachments, and their files, that no message and no profile points at any more.
   * Call it after the transaction that let go of them has committed. Removing the file can fail
   * (storage is down): that is logged and the file stays until the orphan sweep.
   */
  async releaseUnused(ids: readonly string[]): Promise<void> {
    const wanted = [...new Set(ids)];
    if (wanted.length === 0) {
      return;
    }
    const gone = await this.db
      .delete(attachments)
      .where(
        and(
          inArray(attachments.id, wanted),
          notExists(
            this.db
              .select({ one: messages.id })
              .from(messages)
              .where(eq(messages.attachmentId, attachments.id)),
          ),
          notExists(
            this.db
              .select({ one: users.id })
              .from(users)
              .where(eq(users.avatarAttachmentId, attachments.id)),
          ),
        ),
      )
      .returning({ key: attachments.storageKey });
    if (gone.length === 0) {
      return;
    }
    try {
      await this.storage.delete(gone.map((row) => row.key));
    } catch (error) {
      this.logger.warn(
        { err: error, keys: gone.map((row) => row.key) },
        "Could not remove files from storage. They stay there until the orphan sweep.",
      );
    }
  }
}
