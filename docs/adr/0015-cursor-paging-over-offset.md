# 0015. Cursor paging on the chat's sequence number

- Status: accepted
- Date: 2026-11-17, recorded after the decision was implemented

## Context

A chat's history is read newest first, a page at a time, while new messages keep arriving and while the
reader hides or clears messages. The list must not skip or repeat a message between pages, and a page must cost
the same at message 20 as at message 20,000.

## Decision

Every message gets a `seq` when it is stored: the chat's `last_seq + 1`, taken in the send transaction, so a
chat counts 1, 2, 3 with no gaps ([ADR 0014](0014-idempotency-keys-for-sends.md)). History is a cursor on it:

- `GET /chats/:id/messages?before=<messageId>&limit=25`. The id is looked up to its `seq`, and the page is the
  newest `limit` messages with a smaller `seq`, returned oldest first. Default 25, at most 100; a `limit` out of
  range is clamped, not refused.
- The query reads `limit + 1` rows to learn whether there is more. `nextCursor` is the id of the oldest message
  returned, or `null` at the start of the history.
- An id that does not exist, or belongs to another chat, is `400 INVALID_CURSOR`, and the two read the same so
  the response does not say whether the other chat exists.
- The cursor may name a message the viewer has since hidden. It is still a place in the chat, so paging stays
  whole when a hidden message falls on a page boundary.
- What the viewer cleared (`seq <= cleared_before_seq`) and what they deleted for themselves are filtered out in
  the same query. The unique index `(chat_id, seq)` is read backwards, so a page is an index range scan.

## Alternatives considered

- **Offset and limit.** The offset moves every time a message arrives, so the next page repeats or skips
  messages, and the database has to walk past every skipped row.
- **A timestamp cursor.** Two messages can share a millisecond, and clocks on different servers disagree, which
  makes ties and reordering possible. The store also never gives a message an earlier time than the one before
  it, but `seq` makes the order exact without relying on that.
- **Opaque encoded cursor.** Would let us change the scheme later, but the contract in the prototype already
  uses a message id, and an id the client already holds costs nothing to carry.

## Consequences

- Paging is stable under concurrent sends, and the cost of a page does not grow with the history.
- A `seq` is per chat, so it says nothing about order across chats. Nothing needs that.
- Deleting a message for everyone keeps its row (`deleted = true`) so its `seq` stays a valid cursor and the
  list has no hole.
- Full-text search (`?q=`) is not built. It would need a ranking, highlighting and a paging design the client
  does not have; it is on the roadmap ([docs/roadmap.md](../roadmap.md)).
