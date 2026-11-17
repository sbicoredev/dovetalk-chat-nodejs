# 0009. Realtime delivery and presence

- Status: accepted
- Date: 2026-11-15

## Context

People need to hear about messages, chat changes, statuses, typing and who is online, on any of
several API instances, from requests handled by one instance and from jobs run by the worker. The
contract is written from one viewer's side ([ADR 0003](0003-per-viewer-projection.md)), so no two
people receive the same payload for the same change. Clients are browsers that already refetch
everything after a reconnect.

## Decision

**Where events come from.** `RealtimeEvents` in `packages/core` is called by the Messages, Chats,
Contacts and Statuses services after their transaction commits. It returns at once and does the work
in the background, and a failure is logged and swallowed, so a request that succeeded never fails
because Redis hiccuped. The worker gets the same events by calling the same services.
Work is queued per lane (per chat), so one instance announces a chat's changes in the order they
were committed. `idle()` waits for the queue, for tests and for shutdown.

**Per-viewer copies, no chat rooms.** Every event goes to `user:{id}` and nothing is broadcast to a
chat. A message costs one round of queries however large the chat is (the message, the members and
every recipient's address book, one query each); the pure `Projector` makes each person's copy.
`message:new` is followed by that person's `chat:updated`, built from the loaded data with the
message as `lastMessage`.

**One way out.** Everything is published with `@socket.io/redis-emitter` through
`RealtimePublisher`, from the API and the worker alike. The Redis adapter on each API instance
delivers to the sockets it holds. Neither the worker nor a request handler needs a socket server,
and it does not matter which instance a connection is on.

**The gateway.** The handshake (token check, account still exists, `socket.join(user room)`) runs
in the socket.io middleware, so the client is told it is connected only when this instance is already
subscribed. Refusals carry `data.code`: `UNAUTHORIZED`, `SHUTTING_DOWN` or `SERVER_ERROR`.
Handlers are plain `socket.on`, not `@SubscribeMessage`, because the app's global guard and filter
are written for HTTP and a client message has nothing to answer and nothing to throw. WebSocket only
(so no sticky sessions), 16 KB per message, an `Origin` check, no compression. `typing` is validated,
membership is checked when it is sent, `true` is limited to once a second per chat per connection, and
a dropped connection says typing stopped.

**Presence.** In Redis, in Lua. `presence:sockets:{user}` is a sorted set of connections scored by
when each stops counting, and `presence:due` is a sorted set of the people announced online, so being
in it is the state. `connect` and `heartbeat` return true on the 0 to 1 transition. `disconnect` only
reschedules the person to now plus the debounce. `sweep` removes whoever's time is up and returns each
name to exactly one caller. Every instance heartbeats its own connections (15 s) and sweeps (1 s).
A connection counts for 45 s without a heartbeat, which is how a crashed instance's people go
offline. Going offline is delayed 5 s so a reload announces nothing. The settings are `PRESENCE_*`,
and the lifetime must be at least twice the heartbeat. `onlineFor()` is the one rule behind
`ContactDto.online` and `presence` events. If either person blocked the other, each sees the other
as offline and typing between them is not sent.

**Tokens.** A socket is checked once, so it must not outlive the token: a timer closes the transport
at `exp`. It is a transport close (`socket.conn.close()`), not `socket.disconnect()`, because a clean
disconnect tells the client not to reconnect. The client comes back by itself and presents its current
token. A token already past `exp` is refused at the handshake, even inside the 5 s of clock drift that
HTTP forgives. socket.io does not retry a refused handshake, so on `UNAUTHORIZED` the client must
refresh its token and call `connect()` again (the web client does this).

**Shutdown.** Readiness fails and new sockets are refused with `SHUTTING_DOWN`. Presence is released
in one call, then this instance's own sockets are closed at the transport. `server.disconnectSockets()`
is not used: through the adapter it reaches every instance.

## Alternatives considered

- **One payload per chat room.** Cheapest to send, but every viewer has different ids for the same
  people, so it cannot be done without leaking or mistranslating ids.
- **A transactional outbox or a Redis stream with replay.** It would let a client that was away catch
  up exactly. The client already refetches after a reconnect, and an outbox puts a write and a reader
  in every send. Not worth it at this size. Revisit if a client ever has to be offline-first.
- **Long-polling fallback with sticky sessions.** Every browser that can run the app speaks WebSocket.
  Without polling the load balancer needs no stickiness, which is what the scale-out test relies on.
- **In-memory presence per instance.** A person on two instances would be offline when either closes,
  and a crash would leave people online for ever. A shared sorted set with expiry has neither fault.
- **Emitting inside the transaction.** A client could hear about a change that then rolled back.
- **`@SubscribeMessage` handlers.** They would pass through guards, pipes and filters made for HTTP.

## Consequences

- Two instances announcing one chat at the same instant can interleave. Clients match by id and
  refetch on reconnect, so this is tolerated. There is no cross-instance ordering lock.
- A lost event is not replayed. A client sees it on its next load.
- Presence assumes one Redis (or Sentinel), not Cluster, because the scripts build key names.
- Telling a group reads each recipient's contacts, about N squared rows for a group of N. Measured and
  recorded in [docs/scaling.md](../scaling.md).
- There are no events for deleting a status, blocking, renaming or deleting a contact, or profile
  changes: the contract has none ([edge case 71](../edge-cases.md)).
- The web client has to handle `connect_error` with `UNAUTHORIZED` (refresh, then `connect()`). It
  does.

## Changes from the first design

- The first design had `emitToChatMembers(chatId, build)` on the publisher. The chat-member logic is in
  `RealtimeEvents` (which already loads members, hidden messages and address books) and the publisher
  has `emitToUsers(ids, build)` instead, so the publisher stays free of the database.
- A token past `exp` is refused at the handshake. This was found by a test: with the HTTP clock
  tolerance a just-expired token was let in and then closed at once, which made a client flap for
  about five seconds instead of learning it needed a new token.
