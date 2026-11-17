import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";

import type { MeDto } from "@dovetalk/contracts";
import { AttachmentsService, DomainError, DRIZZLE } from "@dovetalk/core";
import { type Database, type Executor, schema, type UserRow } from "@dovetalk/db";

import { toMeDto } from "./me.mapper.js";
import { type ProfilePatch, UsersService } from "./users.service.js";

const { users: userTable } = schema;

export interface ProfileUpdate extends Omit<ProfilePatch, "avatarAttachmentId"> {
  /** One of our signed links to the person's own picture, or `null` to remove the photo. */
  avatarUrl?: string | null;
}

/** The signed-in person's profile as the API shows it: the row plus the signed photo link. */
@Injectable()
export class ProfileService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(AttachmentsService) private readonly attachments: AttachmentsService,
  ) {}

  /** The profile of a row that was just read. */
  async toMe(user: UserRow, executor: Executor = this.db): Promise<MeDto> {
    const id = user.avatarAttachmentId;
    const urls = await this.attachments.urls(executor, id ? [id] : []);
    return toMeDto(user, id ? (urls.get(id) ?? null) : null);
  }

  async get(userId: string): Promise<MeDto> {
    const row = await this.users.findById(userId);
    if (!row) {
      throw new DomainError("UNAUTHORIZED", "Your session has ended. Sign in again.");
    }
    return this.toMe(row);
  }

  /**
   * Changes the profile. A new photo must be one of the person's own uploads that is a picture
   * a browser draws; the old photo's file is removed once nothing else uses it.
   */
  async update(userId: string, patch: ProfileUpdate): Promise<MeDto> {
    const { avatarUrl, ...rest } = patch;
    if (avatarUrl === undefined) {
      return this.toMe(await this.users.updateProfile(userId, rest));
    }

    const { row, replaced } = await this.db.transaction(async (tx) => {
      // Two photo changes at once would each release the other's "old" photo, or leak it.
      const [current] = await tx
        .select({ id: userTable.avatarAttachmentId })
        .from(userTable)
        .where(eq(userTable.id, userId))
        .for("update");
      if (!current) {
        throw new DomainError("UNAUTHORIZED", "Your session has ended. Sign in again.");
      }
      const next =
        avatarUrl === null ? null : await this.attachments.avatarFromLink(tx, userId, avatarUrl);
      const updated = await this.users.updateProfile(
        userId,
        { ...rest, avatarAttachmentId: next?.id ?? null },
        tx,
      );
      return { row: updated, replaced: current.id && current.id !== next?.id ? current.id : null };
    });
    if (replaced) {
      await this.attachments.releaseUnused([replaced]);
    }
    return this.toMe(row);
  }
}
