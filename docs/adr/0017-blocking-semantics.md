# 0017. What blocking does: refuse your own sends, quietly drop theirs

- Status: accepted
- Date: 2026-11-17, recorded after the decision was implemented

## Context

Blocking is a per-person setting on a contact, so in a direct chat there are two cases and they are not
symmetric: you blocked them, or they blocked you. The prototype's mock server pins down some of the behaviour
(sending to someone you blocked is refused, forwarding skips blocked chats). A real multi-user system has to
decide the rest, in particular what the blocked person sees.

## Decision

- **You blocked them, and you send:** `403 CONTACT_BLOCKED`, nothing is stored.
- **They blocked you, and you send:** the message is **stored and shown to you**, and looks sent. It never
  reaches them: no unread count, no `message:new`, and the chat is not revived on their side. The blocker also
  gets a row in `message_hidden` for it, the same mechanism as "delete for me", so the message **stays hidden
  from them for good** and does not appear in their history if they unblock later
  ([edge cases #19](../edge-cases.md)).
- **Typing and presence** stop in both directions. Each sees the other as offline, in the contact list and in
  events. Blocking or unblocking sends both people the contact's current state at once
  ([edge cases #69](../edge-cases.md)).
- **Forwarding** into a chat with a blocked person is skipped silently, as in the mock, so the result can be
  shorter than the list of chats asked for ([edge cases #20](../edge-cases.md)).
- **Bots** do not answer a person who blocked them, and the reply job checks again when it runs
  ([edge cases #82](../edge-cases.md)).
- Group chats are not affected: blocking applies to direct chats.

The check is one query in the send transaction (`MessagesService.blocks`) that returns both directions.

## Alternatives considered

- **Refuse the send for the blocked person too.** It tells them they are blocked, which is the thing blocking
  tries not to reveal.
- **Store it and show it to the blocker after an unblock.** A message sent while blocked would appear later,
  out of context, and the blocker never chose to receive it.
- **Delete the blocked person's message.** The sender would see their own message vanish, which also gives it away.

## Consequences

- The sender's view and the recipient's view of one chat differ. This is intended and is why the projection is
  per viewer ([ADR 0003](0003-per-viewer-projection.md)).
- Blocking, unblocking, renaming and deleting a contact have no socket event of their own in the contract, so
  the other side sees them on its next read ([edge cases #71](../edge-cases.md)).
