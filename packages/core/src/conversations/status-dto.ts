import type { StatusDto } from "@dovetalk/contracts";
import type { StatusRow } from "@dovetalk/db";

import { must } from "../invariant.js";

/**
 * A status as one viewer sees it. `ownerId` is told the way messages tell senders: the viewer's
 * own user id for their notes, otherwise the viewer's contact id for the author.
 */
export function toStatusDto(
  viewerId: string,
  status: StatusRow,
  contactId: string | null,
  viewed: boolean,
): StatusDto {
  const own = status.ownerId === viewerId;
  return {
    id: status.id,
    // A status is only listed for a person with a contact row, so the id is always there.
    ownerId: own ? viewerId : must(contactId, "the contact of a status owner"),
    text: status.text,
    color: status.color,
    createdAt: status.createdAt.getTime(),
    seen: own || viewed,
  };
}
