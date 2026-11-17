import { Inject, Injectable } from "@nestjs/common";

import { type AttachmentDto, IMAGE_EDGE_MAX, UPLOAD_LIMIT_BYTES } from "@dovetalk/contracts";
import { type Database, newId, schema } from "@dovetalk/db";

import { DomainError } from "../errors.js";
import { must } from "../invariant.js";
import { DRIZZLE } from "../tokens.js";
import { AttachmentsService } from "./attachments.service.js";
import { cleanFileName, detectMime, isRasterImage } from "./file-info.js";
import { StorageService } from "./storage.service.js";

const { attachments } = schema;

export interface UploadInput {
  bytes: Uint8Array;
  /** What the client says the type is. Only believed for a few plain-text types. */
  declaredMime?: string | null;
  height?: number | null;
  name?: string | null;
  width?: number | null;
}

const edge = (label: string, value: number | null | undefined): number | null => {
  if (value === null || value === undefined) {
    return null;
  }
  if (!Number.isInteger(value) || value < 1 || value > IMAGE_EDGE_MAX) {
    throw new DomainError("VALIDATION_ERROR", [
      `${label} must be a whole number from 1 to ${IMAGE_EDGE_MAX}.`,
    ]);
  }
  return value;
};

/** Takes a file in: checks it, stores the bytes, and records the attachment. */
@Injectable()
export class UploadsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(StorageService) private readonly storage: StorageService,
    @Inject(AttachmentsService) private readonly attachmentBook: AttachmentsService,
  ) {}

  async create(ownerId: string, input: UploadInput): Promise<AttachmentDto> {
    const size = input.bytes.byteLength;
    if (size === 0) {
      throw new DomainError("VALIDATION_ERROR", ["That file is empty."]);
    }
    if (size > UPLOAD_LIMIT_BYTES) {
      throw tooLarge();
    }
    const width = edge("Width", input.width);
    const height = edge("Height", input.height);

    const mime = await detectMime(input.bytes, input.declaredMime);
    const name = cleanFileName(input.name);
    const id = newId();
    const storageKey = `uploads/${ownerId}/${id}`;
    await this.storage.put(storageKey, input.bytes, { mime, name });

    try {
      const [row] = await this.db
        .insert(attachments)
        .values({
          id,
          ownerId,
          storageKey,
          name,
          size,
          mime,
          // The size of a picture means nothing for any other kind of file.
          width: isRasterImage(mime) ? width : null,
          height: isRasterImage(mime) ? height : null,
        })
        .returning();
      return await this.attachmentBook.dtoOf(must(row, "the inserted attachment"));
    } catch (error) {
      // No row, so nothing would ever find this object again: take it back out.
      await this.storage.delete([storageKey]).catch(() => undefined);
      throw error;
    }
  }
}

export const tooLarge = () =>
  new DomainError(
    "FILE_TOO_LARGE",
    `Files over ${UPLOAD_LIMIT_BYTES / 1_000_000} MB aren't supported.`,
  );
