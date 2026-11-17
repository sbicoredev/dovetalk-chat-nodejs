import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, gt, isNotNull, isNull, or, type SQL, sql } from "drizzle-orm";

import {
  type CreateStatusInput,
  STATUS_COLOR_COUNT,
  STATUS_TEXT_MAX,
  STATUS_TTL_MS,
  type StatusDto,
} from "@dovetalk/contracts";
import { type Database, type StatusRow, schema } from "@dovetalk/db";

import { DomainError } from "../errors.js";
import { must } from "../invariant.js";
import { RealtimeEvents } from "../realtime/realtime-events.service.js";
import { DRIZZLE } from "../tokens.js";
import { isUuid } from "./ids.js";
import { toStatusDto } from "./status-dto.js";

const { contacts, statuses, statusViews } = schema;

const statusNotFound = () => new DomainError("STATUS_NOT_FOUND", "This status no longer exists.");

/** Text is trimmed, empty is an error and a long one is cut (not refused), counting code points. */
function statusText(raw: unknown): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    throw new DomainError("VALIDATION_ERROR", ["Status can't be empty."]);
  }
  // `Array.from` splits by code point, so an emoji is never cut in half. Postgres'
  // `char_length` (the table's check) counts code points too.
  return Array.from(value).slice(0, STATUS_TEXT_MAX).join("");
}

function statusColor(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0 || raw >= STATUS_COLOR_COUNT) {
    throw new DomainError("VALIDATION_ERROR", [
      `Color must be a whole number from 0 to ${STATUS_COLOR_COUNT - 1}.`,
    ]);
  }
  return raw;
}

/** What one viewer may see of the `statuses` table (joined with their own contact row of the owner). */
const visibleTo = (viewerId: string): SQL | undefined =>
  and(
    // Not yet expired. The database clock decides, so API instances cannot disagree.
    gt(statuses.expiresAt, sql`now()`),
    // Their own, or a person they have any contact row for. A saved row is not needed: a person
    // met in a group, or a contact deleted later, keeps showing (docs/edge-cases.md, #38).
    or(eq(statuses.ownerId, viewerId), isNotNull(contacts.id)),
    // The shared bots' notes are one per account: they are for the account they were made for.
    or(isNull(statuses.audienceId), eq(statuses.audienceId, viewerId)),
  );

/**
 * Statuses: short notes that disappear after 24 hours. The viewer sees their own and those of
 * everybody they have a contact row for. `ownerId` is told the way messages tell senders: the
 * viewer's own user id for their notes, otherwise the viewer's contact id for the author.
 *
 * Rules that come up in several places:
 * - A status the viewer cannot see (somebody else's, expired, malformed id) is
 *   `STATUS_NOT_FOUND` (404), never 403. Only a status the viewer can see but did not write is 403
 *   when they try to delete it.
 * - A new status is announced (`status:new`) after it is stored. Deleting one has no event in the
 *   contract: other people's apps drop it when it expires or when they next load.
 */
@Injectable()
export class StatusesService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(RealtimeEvents) private readonly events: RealtimeEvents,
  ) {}

  /** The viewer's statuses, oldest first. */
  async list(viewerId: string): Promise<StatusDto[]> {
    const rows = await this.db
      .select({
        status: statuses,
        contactId: contacts.id,
        viewedAt: statusViews.viewedAt,
      })
      .from(statuses)
      .leftJoin(
        contacts,
        and(eq(contacts.ownerId, viewerId), eq(contacts.linkedUserId, statuses.ownerId)),
      )
      .leftJoin(
        statusViews,
        and(eq(statusViews.statusId, statuses.id), eq(statusViews.viewerId, viewerId)),
      )
      .where(visibleTo(viewerId))
      .orderBy(asc(statuses.createdAt), asc(statuses.id));
    return rows.map(({ status, contactId, viewedAt }) =>
      toStatusDto(viewerId, status, contactId, viewedAt !== null),
    );
  }

  async create(viewerId: string, input: CreateStatusInput): Promise<StatusDto> {
    const text = statusText(input.text);
    const color = statusColor(input.color);
    const [row] = await this.db
      .insert(statuses)
      .values({
        ownerId: viewerId,
        text,
        color,
        // `created_at` is the database's `now()` too, so the two always differ by the lifetime.
        expiresAt: sql`now() + ${STATUS_TTL_MS / 1000} * interval '1 second'`,
      })
      .returning();
    const created = must(row, "the inserted status");
    this.events.statusCreated(viewerId, created.id);
    return toStatusDto(viewerId, created, null, true);
  }

  /** Deletes the viewer's own status. 404 if they cannot see it, 403 if it is somebody else's. */
  async remove(viewerId: string, id: string): Promise<void> {
    const { status } = await this.findVisible(viewerId, id);
    if (status.ownerId !== viewerId) {
      throw new DomainError("FORBIDDEN", "You can only delete your own status.");
    }
    const removed = await this.db
      .delete(statuses)
      .where(and(eq(statuses.id, status.id), eq(statuses.ownerId, viewerId)))
      .returning({ id: statuses.id });
    if (removed.length === 0) {
      // Deleted by another request between the lookup and now.
      throw statusNotFound();
    }
  }

  /** Marks a status as seen by the viewer. Their own, or one already seen, changes nothing. */
  async markSeen(viewerId: string, id: string): Promise<void> {
    const { status } = await this.findVisible(viewerId, id);
    if (status.ownerId === viewerId) {
      return;
    }
    await this.db
      .insert(statusViews)
      .values({ statusId: status.id, viewerId })
      .onConflictDoNothing({ target: [statusViews.statusId, statusViews.viewerId] });
  }

  private async findVisible(
    viewerId: string,
    id: string,
  ): Promise<{ status: StatusRow; contactId: string | null }> {
    if (!isUuid(id)) {
      throw statusNotFound();
    }
    const [row] = await this.db
      .select({ status: statuses, contactId: contacts.id })
      .from(statuses)
      .leftJoin(
        contacts,
        and(eq(contacts.ownerId, viewerId), eq(contacts.linkedUserId, statuses.ownerId)),
      )
      .where(and(eq(statuses.id, id), visibleTo(viewerId)))
      .limit(1);
    if (!row) {
      throw statusNotFound();
    }
    return row;
  }
}
