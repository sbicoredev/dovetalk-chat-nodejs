import { Inject, Injectable } from "@nestjs/common";
import { eq } from "drizzle-orm";

import { DRIZZLE } from "@dovetalk/core";
import { type Database, schema } from "@dovetalk/db";

import type { AuthUser } from "../common/auth-user.js";
import { API_ENV, type ApiEnv } from "../config/env.js";

const { users } = schema;
const MAX_ENTRIES = 10_000;

interface Entry {
  cachedAt: number;
  guestExpiresAt: number | null;
  user: AuthUser | null;
}

/**
 * Answers "is this user still there?" for a token that is otherwise valid. A signed token
 * outlives its account (a guest being cleaned up, a deleted user) by up to 15 minutes, so
 * the guard asks. Answers are kept in memory for AUTH_CACHE_TTL_MS so this costs one query per
 * user per half minute, not one per request. In a cluster each instance has its own cache, so
 * a deleted user can stay signed in for at most that long.
 */
@Injectable()
export class AuthUserDirectory {
  private readonly cache = new Map<string, Entry>();

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  async find(userId: string): Promise<AuthUser | null> {
    const now = Date.now();
    const cached = this.cache.get(userId);
    if (cached && now - cached.cachedAt < this.env.AUTH_CACHE_TTL_MS) {
      // Never serve a guest past the moment they expire, however fresh the entry is.
      if (cached.guestExpiresAt !== null && now >= cached.guestExpiresAt) {
        return null;
      }
      return cached.user;
    }

    const [row] = await this.db
      .select({
        id: users.id,
        isGuest: users.isGuest,
        isBot: users.isBot,
        guestExpiresAt: users.guestExpiresAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const expiresAt = row?.guestExpiresAt?.getTime() ?? null;
    const alive = row && !row.isBot && (expiresAt === null || expiresAt > now);
    const user = alive ? { id: row.id, isGuest: row.isGuest } : null;
    this.remember(userId, { user, guestExpiresAt: expiresAt, cachedAt: now });
    return user;
  }

  /** Forget a user, for example right after their account is deleted. */
  forget(userId: string) {
    this.cache.delete(userId);
  }

  private remember(userId: string, entry: Entry) {
    if (this.env.AUTH_CACHE_TTL_MS === 0) {
      return;
    }
    // Maps iterate in insertion order, so the first key is the oldest. Good enough for a bound.
    if (this.cache.size >= MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) {
        this.cache.delete(oldest.value);
      }
    }
    this.cache.set(userId, entry);
  }
}
