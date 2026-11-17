import { createHash, randomBytes } from "node:crypto";

import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, isNull, sql } from "drizzle-orm";

import { DomainError, DRIZZLE, must } from "@dovetalk/core";
import { type Database, type Executor, newId, schema } from "@dovetalk/db";

import { API_ENV, type ApiEnv } from "../config/env.js";

const { refreshTokens, users } = schema;

/** A token is 32 random bytes, base64url: 43 characters. Anything else is not ours. */
const TOKEN_FORMAT = /^[A-Za-z0-9_-]{43}$/u;

export interface IssuedRefreshToken {
  expiresAt: Date;
  /** The secret. Goes to the browser once, in a cookie. Only its hash is stored. */
  token: string;
}

export interface RotatedSession {
  refresh: IssuedRefreshToken;
  userId: string;
}

type Outcome =
  | { ok: true; userId: string; refresh: IssuedRefreshToken }
  | {
      ok: false;
      reason: "unknown" | "revoked" | "expired" | "guest_expired" | "reuse";
      userId?: string;
      familyId?: string;
    };

const unauthorized = () =>
  new DomainError("UNAUTHORIZED", "Your session has ended. Sign in again.");

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Refresh tokens: long-lived, opaque, rotated on every use.
 *
 * Each sign-in starts a *family*. Every refresh retires the token it was given and issues the
 * next one in the same family. A retired token that shows up again later has been copied, so the
 * whole family is revoked and both the thief and the person are signed out. A retired token that
 * shows up again within a few seconds is a double request (two tabs, StrictMode), and is let
 * through, because treating it as theft would sign out someone who did nothing wrong.
 */
@Injectable()
export class RefreshTokenService {
  private readonly logger = new Logger(RefreshTokenService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /** Starts a new family for a fresh sign-in. */
  issue(userId: string, userAgent: string | undefined, executor: Executor = this.db) {
    return this.insert(executor, { userId, familyId: newId(), userAgent });
  }

  /**
   * Trades a refresh token for the next one. Throws UNAUTHORIZED if it is unknown, expired,
   * revoked or reused. Concurrent calls with the same token are serialised by a row lock.
   */
  async rotate(token: string | undefined, userAgent: string | undefined): Promise<RotatedSession> {
    if (!(token && TOKEN_FORMAT.test(token))) {
      throw unauthorized();
    }
    const windowSeconds = this.env.REFRESH_REUSE_WINDOW_MS / 1000;

    const outcome = await this.db.transaction(async (tx): Promise<Outcome> => {
      const [row] = await tx
        .select({
          id: refreshTokens.id,
          userId: refreshTokens.userId,
          familyId: refreshTokens.familyId,
          rotated: sql<boolean>`${refreshTokens.rotatedAt} is not null`,
          revoked: sql<boolean>`${refreshTokens.revokedAt} is not null`,
          expired: sql<boolean>`${refreshTokens.expiresAt} <= now()`,
          // Compared in SQL so every API instance judges by the database's clock, not its own.
          withinReuseWindow: sql<boolean>`${refreshTokens.rotatedAt} > now() - make_interval(secs => ${windowSeconds})`,
          guestExpired: sql<boolean>`${users.guestExpiresAt} <= now()`,
        })
        .from(refreshTokens)
        .innerJoin(users, eq(users.id, refreshTokens.userId))
        .where(eq(refreshTokens.tokenHash, hashToken(token)))
        .for("update", { of: refreshTokens });

      if (!row) {
        return { ok: false, reason: "unknown" };
      }
      const base = { userId: row.userId, familyId: row.familyId };
      if (row.revoked) {
        return { ok: false, reason: "revoked", ...base };
      }
      if (row.expired) {
        return { ok: false, reason: "expired", ...base };
      }
      if (row.guestExpired) {
        await this.revokeFamily(tx, row.familyId);
        return { ok: false, reason: "guest_expired", ...base };
      }

      if (row.rotated && !row.withinReuseWindow) {
        await this.revokeFamily(tx, row.familyId);
        return { ok: false, reason: "reuse", ...base };
      }
      if (!row.rotated) {
        await tx
          .update(refreshTokens)
          .set({ rotatedAt: sql`now()` })
          .where(eq(refreshTokens.id, row.id));
      }
      const refresh = await this.insert(tx, {
        userId: row.userId,
        familyId: row.familyId,
        userAgent,
      });
      return { ok: true, userId: row.userId, refresh };
    });

    if (!outcome.ok) {
      if (outcome.reason === "reuse") {
        this.logger.warn(
          { userId: outcome.userId, familyId: outcome.familyId },
          "Refresh token reuse detected, sign-in revoked",
        );
      }
      throw unauthorized();
    }
    return { userId: outcome.userId, refresh: outcome.refresh };
  }

  /** Ends the sign-in this token belongs to. Unknown tokens are ignored: logging out twice is fine. */
  async revokeFamilyOf(token: string | undefined): Promise<void> {
    if (!(token && TOKEN_FORMAT.test(token))) {
      return;
    }
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: sql`now()` })
      .where(
        and(
          isNull(refreshTokens.revokedAt),
          eq(
            refreshTokens.familyId,
            sql`(select family_id from refresh_tokens where token_hash = ${hashToken(token)})`,
          ),
        ),
      );
  }

  private async revokeFamily(executor: Executor, familyId: string) {
    await executor
      .update(refreshTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)));
  }

  private async insert(
    executor: Executor,
    input: { userId: string; familyId: string; userAgent?: string },
  ): Promise<IssuedRefreshToken> {
    const token = randomBytes(32).toString("base64url");
    const lifetime = this.env.REFRESH_TOKEN_TTL_DAYS * 86_400;
    // A guest's sign-in never outlives the guest. `least` ignores a null expiry.
    const [row] = await executor
      .insert(refreshTokens)
      .values({
        userId: input.userId,
        familyId: input.familyId,
        tokenHash: hashToken(token),
        userAgent: input.userAgent?.slice(0, 255),
        expiresAt: sql`least(now() + make_interval(secs => ${lifetime}), (select guest_expires_at from users where id = ${input.userId}))`,
      })
      .returning({ expiresAt: refreshTokens.expiresAt });
    return { token, expiresAt: must(row, "the inserted refresh token").expiresAt };
  }
}
