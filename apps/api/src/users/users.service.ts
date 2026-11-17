import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

import {
  DEFAULT_ABOUT,
  GUEST_EMAIL_DOMAIN,
  GUEST_TTL_MS,
  type Preferences,
} from "@dovetalk/contracts";
import { DomainError, DRIZZLE, must, parsePhone } from "@dovetalk/core";
import {
  type Database,
  type Executor,
  isUniqueViolation,
  newId,
  schema,
  type UserRow,
} from "@dovetalk/db";

const { users } = schema;

export interface NewAccount {
  email: string;
  /** Leave out for a random colour. The demo account sets one so it looks the same everywhere. */
  hue?: number;
  name: string;
  passwordHash: string;
  phone?: string;
}

export interface ProfilePatch {
  about?: string;
  /** The upload that is now the profile photo, or `null` to remove it. Already checked by the caller. */
  avatarAttachmentId?: string | null;
  name?: string;
  phone?: string | null;
  preferences?: Partial<Preferences>;
}

const randomHue = () => Math.floor(Math.random() * 360);

const EMAIL_TAKEN = () =>
  new DomainError("EMAIL_TAKEN", "An account with this email already exists.");
const PHONE_TAKEN = () => new DomainError("PHONE_TAKEN", "That phone number is already in use.");

/** Reads and writes `users` rows. Rules about who may do what live in the callers. */
@Injectable()
export class UsersService {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  async findById(id: string, executor: Executor = this.db): Promise<UserRow | undefined> {
    const [row] = await executor.select().from(users).where(eq(users.id, id)).limit(1);
    return row;
  }

  /** People who can sign in. Bots never can, and guests have no password, so neither is found. */
  async findSignInByEmail(email: string): Promise<UserRow | undefined> {
    const [row] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.email, email), eq(users.isBot, false), eq(users.isGuest, false)))
      .limit(1);
    return row;
  }

  /** Creates a real account. Pass a transaction to create the person's starting data in the same one. */
  async createAccount(account: NewAccount, executor: Executor = this.db): Promise<UserRow> {
    try {
      const [row] = await executor
        .insert(users)
        .values({
          email: account.email,
          passwordHash: account.passwordHash,
          name: account.name,
          phone: account.phone ? parsePhone(account.phone)?.display : undefined,
          hue: account.hue ?? randomHue(),
        })
        .returning();
      return must(row, "the inserted user");
    } catch (error) {
      throw this.translate(error);
    }
  }

  /** A throwaway account for the live demo. It has no password and is deleted after 24 hours. */
  async createGuest(executor: Executor = this.db): Promise<UserRow> {
    const id = newId();
    const [row] = await executor
      .insert(users)
      .values({
        id,
        email: `guest-${id}@${GUEST_EMAIL_DOMAIN}`,
        name: `Guest ${Math.floor(1000 + Math.random() * 9000)}`,
        about: DEFAULT_ABOUT,
        hue: randomHue(),
        isGuest: true,
        guestExpiresAt: new Date(Date.now() + GUEST_TTL_MS),
      })
      .returning();
    return must(row, "the inserted guest");
  }

  /**
   * Applies only the fields that were sent. Preferences are merged by the database in one
   * statement, so two devices changing different settings cannot overwrite each other.
   */
  async updateProfile(
    id: string,
    patch: ProfilePatch,
    executor: Executor = this.db,
  ): Promise<UserRow> {
    const set: PgUpdateSetSource<typeof users> = {};
    if (patch.avatarAttachmentId !== undefined) {
      set.avatarAttachmentId = patch.avatarAttachmentId;
    }
    if (patch.name !== undefined) {
      set.name = patch.name;
    }
    if (patch.about !== undefined) {
      set.about = patch.about;
    }
    if (patch.phone !== undefined) {
      set.phone = patch.phone === null ? null : (parsePhone(patch.phone)?.display ?? null);
    }
    if (patch.preferences && Object.keys(patch.preferences).length > 0) {
      set.preferences = sql`${users.preferences} || ${JSON.stringify(patch.preferences)}::jsonb`;
    }

    if (Object.keys(set).length === 0) {
      const current = await this.findById(id, executor);
      if (!current) {
        throw new DomainError("UNAUTHORIZED", "Your session has ended. Sign in again.");
      }
      return current;
    }

    try {
      const [row] = await executor.update(users).set(set).where(eq(users.id, id)).returning();
      if (!row) {
        throw new DomainError("UNAUTHORIZED", "Your session has ended. Sign in again.");
      }
      return row;
    } catch (error) {
      throw this.translate(error);
    }
  }

  private translate(error: unknown): unknown {
    if (isUniqueViolation(error, "users_email_key")) {
      return EMAIL_TAKEN();
    }
    if (isUniqueViolation(error, "users_phone_digits_key")) {
      return PHONE_TAKEN();
    }
    return error;
  }
}
