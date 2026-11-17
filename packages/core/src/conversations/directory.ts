import { and, eq, inArray } from "drizzle-orm";

import { type Executor, schema } from "@dovetalk/db";

import { createDirectory, type ViewerDirectory } from "./projector.js";

const { contacts, users } = schema;

/**
 * Loads how one viewer names people: one query, however many people. Pass `userIds` to load only
 * the people a page of messages mentions, or leave it out for everyone the viewer has a contact
 * row for (the chat list needs them all, to name every member of every chat).
 */
export async function loadDirectory(
  executor: Executor,
  viewerId: string,
  userIds?: readonly string[],
): Promise<ViewerDirectory> {
  if (userIds && userIds.length === 0) {
    return createDirectory(viewerId, []);
  }
  const rows = await executor
    .select({
      userId: contacts.linkedUserId,
      contactId: contacts.id,
      name: contacts.name,
      contactHue: contacts.hue,
      profileHue: users.hue,
    })
    .from(contacts)
    .innerJoin(users, eq(users.id, contacts.linkedUserId))
    .where(
      userIds
        ? and(eq(contacts.ownerId, viewerId), inArray(contacts.linkedUserId, [...userIds]))
        : eq(contacts.ownerId, viewerId),
    );
  return createDirectory(
    viewerId,
    rows.map((row) => ({
      userId: row.userId,
      contactId: row.contactId,
      name: row.name,
      hue: row.contactHue ?? row.profileHue,
    })),
  );
}
