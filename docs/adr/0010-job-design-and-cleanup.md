# 0010. Job design and cleanup semantics

- Status: accepted
- Date: 2026-11-15

## Context

The worker takes two kinds of work: bot replies, and four repeating cleanup jobs. Both run
at-least-once on BullMQ ([ADR 0004](0004-bullmq-over-rabbitmq.md)), on any number of worker replicas, and a
worker can die at any moment. Cleanup also deletes people's data, so it has to be careful about what it
takes.

## Decision: bot replies

- **Who answers.** `findBotCandidates` is the one rule, used when the message is sent and again when the job
  runs, because blocks and memberships change in between. Only a person's message sets a bot going (a
  bot's never does, which stops bots in a group answering each other, edge case 24). The sender must still
  have the chat on their list, so a chat deleted while the bot was "typing" is not brought back. A bot the
  sender blocked stays quiet.
- **Groups too.** The first design covered direct chats only. The mock answers in groups as well, and the conformance
  suite is written against the mock, so a group answers with one of its bots, picked by hashing the message
  id.
- **Deterministic, not random.** The bot and the line follow from the message id, so a retried job says the
  same thing and a replayed reply is byte for byte the first one.
- **Two jobs per message.** "Typing" at about 700 ms and the reply at about 2400 ms, added together with
  `addBulk`. If the typing job runs when the reply is already due (the worker was down), it does nothing
  (outcome `late`): a typing indicator that appears and disappears in the same instant is noise.
- **Failure.** The reply gets 5 attempts with exponential backoff from 1 s, typing gets 2. A job that is
  out of attempts stays in the failed set for 7 days and clears the chat's hold and the bot's "typing".
- **Realtime events are best effort.** `send()` announces a message after commit, in the background, and
  does not wait for the fan-out (ADR 0009). A worker that exits through SIGTERM flushes them. One killed
  with SIGKILL can lose the events of replies it had just committed. The reply is stored and the client
  gets it when it next loads, which is the same promise as for any lost event.

## Decision: cleanup jobs

Four jobs, each repeating on its own interval (`CLEANUP_*_EVERY_MS`), each working in batches of
`CLEANUP_BATCH_SIZE` rows inside a transaction, and each safe to run on several replicas at once.

- **Storage first, in the transaction.** Files are deleted from object storage before their rows go, in the
  same transaction. If storage fails the transaction rolls back, every row is still there, and the next run
  tries again. The other order would lose the keys, and with them the files.
- **`FOR UPDATE SKIP LOCKED`.** Replicas take different rows and never wait for each other. The orphan sweep
  relies on it against a concurrent send: sending a message locks the attachment row before claiming it,
  so the sweep either sees the lock and skips the file, or the send waits and then finds the file gone,
  which is the right answer for a file over 24 hours old.
- **Expired statuses.** Readers already hide a note by the database clock, so the job only stops the table
  growing.
- **Refresh tokens: expired and long-revoked ones go, rotated ones stay until they expire.** Presenting a
  rotated token again is how a stolen copy is noticed (the whole sign-in is revoked, edge case 26), and
  that needs the row. A revoked token needs nothing, since using it is a 401 like an unknown one.
- **Expired guests.** The database cascades most of it (sessions, contacts, memberships, messages, files,
  notes, ghost contacts). The job adds what the cascade cannot: removing the files from storage, and
  deleting chats nobody real is left in (a guest's chats with the shared bots would otherwise stay for ever
  with a bot as the only member).

### The forwarded-attachment decision

Forwarding shares the original's file. If a guest uploaded a picture and a real user forwarded it, the
cascade would delete the guest's file and leave the real user's forward pointing at nothing. A forward is the
forwarder's own message, so:

- a guest's file that somebody **staying** has forwarded is handed to them: `attachments.owner_id` moves to
  the **earliest** such sender (message ids are UUIDv7, so the lowest id is the first sent);
- the heir may not be a guest whose own time is up too. That file would only be deleted by their batch, and
  handing it over would take a row lock on a user another batch is deleting;
- the object stays in storage, and the job's result counts it in `kept` (files deleted are `files`);
- the guest's own message goes with them, as before; only the file and the forwards survive.

The cost is that a real user can end up owning a file they did not upload. The alternative, deleting it, breaks a
message that person sent. A profile photo is not affected: an avatar must be the user's own upload
(`avatarFromLink` checks the owner) and the foreign key is `ON DELETE SET NULL`.

### Housekeeping starts when the schedule is created

Each worker calls `upsertJobScheduler` at start for all four jobs. That is idempotent: Redis ends up with
one schedule per job whatever the number of replicas or restarts. The first occurrence is due at once, so
**the housekeeping runs when a schedule is first created**, which is on a fresh Redis or a new
`QUEUE_PREFIX` (a new deployment). Checked with real processes: a restarted worker and a second replica
added no runs, and Redis held four schedules with two replicas. It is fine in production: the jobs are
idempotent and cheap, and the first run clears whatever built up before the worker existed. In tests
every worker starts on a fresh prefix, so each one runs the four jobs at boot, and the harness waits for
those runs before a test starts (a run in the middle of a test's setup could delete its fresh expired guest).

## Consequences

- Adding a replica adds capacity for bot replies and nothing else: the cleanup jobs run once per period in
  total.
- The worker can be killed at any moment without losing a reply. What it can lose is the realtime event of a
  reply stored in the last instants.
- A guest's deleted account can leave a file owned by a real person. `kept` in the job log shows when.

## What was verified, and how

In-process tests (`apps/worker/test`) cover every rule above against real Postgres, Redis and an S3
stand-in. Against separate `node dist/main.js` processes (API and worker) the following ran: the conformance `bots` test (and the whole suite, 49 of 49); a worker killed with SIGKILL while
both jobs were still delayed; a worker killed while up to 16 reply jobs were active (including 4 whose
reply was already stored, answered `already-sent` after the recovery); the same load stopped with SIGTERM
(the worker exits after its running jobs, nothing is lost); and two replicas on one prefix sharing 20 chats,
each job finishing once.

## Changes from the first design

These are the places where the bot replies and cleanup jobs differ from how they were first designed.

- **Job ids** are `bot-reply-{messageId}` and `bot-typing-{messageId}`, not `bot-reply:{messageId}`, because
  BullMQ 6 rejects `:` in a custom id. The reply's `clientId` keeps the colon.
- **Groups.** Bots also answer in group chats, as the mock does. The first design had direct chats only.
- **Deterministic picks.** The bot and the line come from a hash of the message id, not from a random choice,
  so a retried job says the same thing.
- **`bullmq` is used directly**, not `@nestjs/bullmq` (ADR 0004).
- **Guest cleanup hands over a forwarded file** instead of deleting it (above).
- **Housekeeping runs when its schedule is created**, not at every worker start (above).
- **Tests do not assert deletion through a signed URL.** With SeaweedFS a signed link to a missing key is a
  404, but the S3 stand-in used in the sandbox (moto) answers 403, so "the link no longer works" proves
  nothing there. Three older api tests (in `messages-write.test.ts` and `uploads.test.ts`) now call
  `objectBehind(url)` from `apps/api/test/support/storage.ts`, which finds the object's key and asks storage
  with a HEAD request (`TestStorage.objectExists`, in `packages/testkit`). The assertion is the same and it
  no longer depends on which S3 server answers.
- **Compose.** The `worker` service waits for `migrate` as well as Postgres and Redis, so it never starts
  against a database without its tables. It has no published port and no fixed name, so
  `--scale worker=2` works.
