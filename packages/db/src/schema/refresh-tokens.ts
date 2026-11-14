import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { newId } from "../ids.js";
import { users } from "./users.js";

/**
 * One row per refresh token ever issued. Only a SHA-256 of the token is stored, so a copy of this
 * table cannot be used to sign in.
 *
 * A *family* is one sign-in and every token rotated out of it. Using a token that was already
 * rotated, outside the short reuse window, means it was copied, so the whole family is revoked.
 */
export const refreshTokens = pgTable(
  "refresh_tokens",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    familyId: uuid("family_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set when this token was exchanged for a new one. */
    rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    userAgent: text("user_agent"),
  },
  (table) => [
    uniqueIndex("refresh_tokens_token_hash_key").on(table.tokenHash),
    index("refresh_tokens_user_id_idx").on(table.userId),
    index("refresh_tokens_family_id_idx").on(table.familyId),
    // The cleanup job deletes by expiry.
    index("refresh_tokens_expires_at_idx").on(table.expiresAt),
  ],
);

export type RefreshTokenRow = typeof refreshTokens.$inferSelect;
export type NewRefreshToken = typeof refreshTokens.$inferInsert;
