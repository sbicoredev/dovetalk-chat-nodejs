# 0004. BullMQ over RabbitMQ

- Status: accepted
- Date: 2026-11-13 (finished 2026-11-15, when the worker was built)

## Context

Background work is bot replies (delayed by a couple of seconds) and periodic cleanup (expired guests,
statuses, orphan files, refresh tokens). Redis is already required for the socket.io adapter, presence
and throttling.

## Decision

BullMQ on Redis. It has delayed and repeatable jobs built in, and retries with backoff. Every processor
is idempotent, because jobs are at-least-once. How the jobs behave is in [ADR 0010](0010-job-design-and-cleanup.md).

### Plain `bullmq`, not `@nestjs/bullmq`

The first-party Nest integration (`@nestjs/bullmq`) was the obvious choice. The code uses `bullmq` directly (`Queue` in
`packages/core`, `Worker` in `apps/worker/src/jobs/run-worker.ts`) for two reasons.

- **Connections.** A worker's blocking connection must never give up on a command (`maxRetriesPerRequest:
  null`), while the general Redis connection is set to fail fast so an outage shows up as errors and not as
  hung requests. `queueConnection()` makes the right one for BullMQ, and the module has no hidden connection
  to configure around.
- **Shutdown order.** A worker has to stop taking jobs and finish the running ones *before* the database,
  Redis and the realtime publisher close under it. The processors close their workers in
  `beforeApplicationShutdown`, which Nest runs ahead of the `onApplicationShutdown` where core closes
  connections. With the wrapper that order is out of our hands.

### How at-least-once is made safe

- **Job ids are deterministic:** `bot-reply-{messageId}` and `bot-typing-{messageId}`. Adding a job with an
  id that exists is a no-op. (The first idea was `bot-reply:{messageId}`. BullMQ 6 rejects `:` in a custom id, so
  the job id uses a dash. The reply's `clientId` is still `bot-reply:{messageId}`, a different field that
  has no such rule.)
- **The reply is idempotent.** The bot and the line are chosen from the message id alone, and the reply is
  sent through `MessagesService.send` under that `clientId`, so a second attempt is the replay of the first and
  adds nothing, not even an unread. Showing and clearing "typing" are idempotent by nature.
- **One pending reply per chat, as in the mock.** A Redis key `{prefix}:bot-reply-pending:{chatId}`, set with
  `SET NX PX 30000`, is the hold. The reply job releases it (only if the message that took it is the one
  releasing), and it lapses on its own after 30 seconds if the job never does.
- **Dead letters.** A job out of attempts stays in the failed set for 7 days (`removeOnFail`), which is the
  dead-letter store. A bot reply that fails for good also clears the chat's hold and the bot's "typing", so
  the chat does not wait for an answer that will never come.
- **Stalled jobs.** If a worker dies with a job active, another takes it once its lock lapses (BullMQ's
  default is 30 seconds, then up to one more check interval). This was exercised with real processes, see
  ADR 0010.

## Alternatives considered

- **RabbitMQ.** A strong broker, but it adds a service, and delayed delivery needs a plugin or a
  dead-letter workaround. Repeatable jobs need an external scheduler.
- **Transactional outbox** (write the job in the same transaction as the message, a relay publishes it).
  It closes the gap where a crash between commit and enqueue loses a job. The gap exists here: `send()`
  stores the message, then schedules the bot in the background. For bot replies it is harmless: the user
  simply gets no auto-reply. The pattern is worth revisiting if jobs ever carry money or must not be lost.

## Consequences

Redis must run with `maxmemory-policy noeviction`, which `docker-compose.yml` sets, because evicting a
queue key would silently drop jobs. BullMQ polling costs requests on pay-per-request Redis plans, which
has to be checked before choosing a host. The API and the worker must share `QUEUE_PREFIX`, and two
deployments sharing one Redis must not.
