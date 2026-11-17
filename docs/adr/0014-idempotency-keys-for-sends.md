# 0014. Idempotent sends with a client-made key

- Status: accepted
- Date: 2026-11-17, recorded after the decision was implemented

## Context

A phone on a bad connection sends a message, loses the response and sends it again. A browser tab and
a retrying proxy do the same. Without a defence the other person reads the message twice, the unread count
is off by one and a chat's order has a hole. The same risk exists inside the system: BullMQ jobs are
at-least-once, so a bot's reply can be attempted twice.

## Decision

`POST /chats/:id/messages` takes a `clientId` that the sender's app makes up. A message is identified by
`(chat, sender, clientId)`, and sending it again returns the stored message with `200` instead of `201`.
A replay stores nothing, takes no place in the chat's order, adds no unread count and emits no socket event.

How it is enforced, in order:

1. The send runs in one transaction that first takes a **row lock on the chat**. Two sends with the same
   `clientId` at once are therefore serialised, and the second finds the first.
2. Inside the lock, the service looks up `(chat, sender, clientId)`. If a row exists, that is the replay.
3. A **partial unique index** on `(chat_id, sender_id, client_id) where client_id is not null` is the backstop.
   If a send ever loses a race the lock should have prevented, the unique violation is caught and answered as
   a replay.
4. `MessageDto.clientId` is returned only to the sender and is `null` for everyone else, so it does not leak
   who sent what and when ([edge cases #43](../edge-cases.md)).

The worker uses the same key. A bot's reply is sent through the same `MessagesService.send` with the
`clientId` `bot-reply:{messageId}`, so a retried job is a replay and cannot post twice
([ADR 0004](0004-bullmq-over-rabbitmq.md)).

## Alternatives considered

- **`INSERT ... ON CONFLICT DO NOTHING` first** (the first sketch). By the time the insert conflicts, the
  transaction has already taken the chat's next `seq`, so a replay would burn a sequence number and leave a
  gap, which history paging does not expect ([ADR 0015](0015-cursor-paging-over-offset.md)). Looking up first
  avoids that ([edge cases #10](../edge-cases.md)); the conflict clause is kept only as the race backstop.
- **A server-side dedupe table with a TTL.** More moving parts, and it needs its own cleanup. The unique index
  gives the same guarantee for the lifetime of the message, at no extra cost.
- **`Idempotency-Key` header for every endpoint.** Only sends have a client that retries blindly and a
  user-visible harm from a duplicate. Edits, reactions and deletes are naturally idempotent (they set a state),
  so a general mechanism was not worth its complexity.

## Consequences

- The chat row lock serialises sends **within one chat** only. Two chats never wait for each other. A very
  busy single chat is the ceiling; [docs/scaling.md](../scaling.md) says what changes if that matters.
- A client must make a new `clientId` for a new message and reuse it only for a retry of the same one. The web
  app makes it when the user presses send, before the first attempt.
- Tests: eight sends of one `clientId` at the same moment produce one message and one unread, and the same
  `clientId` from two people, or in two chats, is two messages (`messages.write.test.ts`).
  A replay emits no socket event (`realtime-events.test.ts`, `apps/api/test/realtime.test.ts`) and queues no bot job
  (`apps/api/test/bot-replies.test.ts`).
