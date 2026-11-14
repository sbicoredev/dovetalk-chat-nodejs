import { sql } from "drizzle-orm";
import {
  check,
  index,
  pgTable,
  // biome-ignore lint/suspicious/noDeprecatedImports: only the positional overload is deprecated; this file uses { columns }.
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { STATUS_COLOR_COUNT, STATUS_TEXT_MAX } from "@dovetalk/contracts";

import { newId } from "../ids.js";
import { users } from "./users.js";

/**
 * A short note that disappears after 24 hours. Everyone who has the author as a contact sees it.
 *
 * - `audience_id` is set only on the notes of the shared bots that a new account is seeded with.
 *   The bots are one row for every account, so their notes would otherwise be shown to all
 *   of them, and every account's copies would pile up. A note with an audience belongs to that
 *   one person and goes with them.
 * - `expires_at` is stored, not computed from `created_at`, so the lifetime can change later
 *   without touching old rows.
 */
export const statuses = pgTable(
  "statuses",
  {
    id: uuid("id").primaryKey().$defaultFn(newId),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    audienceId: uuid("audience_id").references(() => users.id, { onDelete: "cascade" }),
    text: text("text").notNull(),
    color: smallint("color").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    // "Whose notes are there, newest last": the list reads a few owners' rows by time.
    index("statuses_owner_id_created_at_idx").on(table.ownerId, table.createdAt),
    // The expiry sweep.
    index("statuses_expires_at_idx").on(table.expiresAt),
    index("statuses_audience_id_idx")
      .on(table.audienceId)
      .where(sql`${table.audienceId} is not null`),
    check(
      "statuses_color_range",
      sql`${table.color} between 0 and ${sql.raw(String(STATUS_COLOR_COUNT - 1))}`,
    ),
    check(
      "statuses_text_length",
      sql`char_length(${table.text}) between 1 and ${sql.raw(String(STATUS_TEXT_MAX))}`,
    ),
    check("statuses_expires_after_created", sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

/** Who has seen which note. The author's own notes are always "seen" and have no rows here. */
export const statusViews = pgTable(
  "status_views",
  {
    statusId: uuid("status_id")
      .notNull()
      .references(() => statuses.id, { onDelete: "cascade" }),
    viewerId: uuid("viewer_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    viewedAt: timestamp("viewed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "status_views_pkey", columns: [table.statusId, table.viewerId] }),
    index("status_views_viewer_id_idx").on(table.viewerId),
  ],
);

export type StatusRow = typeof statuses.$inferSelect;
export type NewStatus = typeof statuses.$inferInsert;
export type StatusViewRow = typeof statusViews.$inferSelect;
export type NewStatusView = typeof statusViews.$inferInsert;
