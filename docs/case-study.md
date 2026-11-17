# Case study: building a chat backend that can be read and scaled

## Summary

Dovetalk is a chat application: accounts, contacts, groups, messages with photos, files and voice notes, statuses,
typing and presence, and bots that answer. It started as a finished web client running on a mock server, and the job
was to build the real backend behind it without changing the client's behaviour. The result is a NestJS API and a
separate worker, PostgreSQL, Redis and S3-compatible storage, with the client switched over to the real thing. It
shows exactly-once sends under retries, stable paging while a chat changes, live delivery across several API
instances with no sticky sessions, and one trace that follows a message from the API through Redis and the worker to
the database. Load tests held 5,000 sockets on three instances on a small machine, and every claim in the repository
says whether it was measured or only written.

## The starting point

A Next.js chat client already worked against an in-browser mock server. That is a useful position: the client's
behaviour is the specification, and "done" is measurable. The approach was to make a **single suite of behaviour tests**
and run it against the mock and against the new API. Wherever the two disagreed, one of them was wrong, and the
test said which ([ADR 0007](adr/0007-one-conformance-suite-for-both-backends.md)). That suite is also what made it
safe to swap the backend under a working client.

## Decisions that shaped it

- **Two deployables, one set of rules.** The API handles requests and sockets; the worker runs bots and cleanup.
  They scale separately and never import each other. Every business rule lives once in `packages/core` and both
  call it, which a lint rule enforces ([ADR 0001](adr/0001-two-deployables-shared-libraries.md)).
- **Every person sees their own ids.** In a shared database, the same message is a different object to each viewer,
  because each has their own contacts. Mapping ids on the way out in one place, instead of in every query, removed a
  whole class of leaks ([ADR 0003](adr/0003-per-viewer-projection.md)).
- **A send that can be repeated.** Phones retry. A client-made key, a lock on the chat and a unique index mean the
  same send twice is one message, one unread, one event ([ADR 0014](adr/0014-idempotency-keys-for-sends.md)).
  The same idea makes a bot's reply safe when a job runs twice.
- **Paging on a sequence number, not an offset.** A page costs the same at message 20 as at 20,000 and does not
  skip or repeat when messages arrive ([ADR 0015](adr/0015-cursor-paging-over-offset.md)).
- **Realtime without sticky sessions.** Each person has a room, events go through Redis, and any instance can serve
  any socket. A crashed instance's people go offline through a heartbeat, not a hope
  ([ADR 0009](adr/0009-realtime-delivery-and-presence.md), [ADR 0013](adr/0013-scale-out-without-sticky-sessions.md)).
- **Boring where it counts.** Drizzle over an ORM that hides the SQL, BullMQ on the Redis already there instead of a
  second broker, Biome instead of two lint tools, and a written dependency policy with its exceptions recorded
  ([ADR 0002](adr/0002-drizzle-over-prisma.md), [ADR 0004](adr/0004-bullmq-over-rabbitmq.md),
  [ADR 0005](adr/0005-dependency-policy.md)).

## Hard problems

- **Ordering under concurrency.** Fan-out must not reorder a chat's messages. After the commit, each API instance
  announces a chat's changes through a per-chat queue, in order, and the sender's response does not wait for it.
  Two instances announcing one chat at the same instant can interleave; there is no lock across instances. That is
  accepted because clients match by id and refetch on reconnect ([ADR 0009](adr/0009-realtime-delivery-and-presence.md)).
- **Someone blocks you.** Your message must look sent to you and never reach them, and must stay hidden if they
  unblock later ([ADR 0017](adr/0017-blocking-semantics.md)).
- **Tokens that survive two tabs.** Refresh tokens rotate, and replaying a retired one revokes the family. Two tabs
  refreshing at once are not an attack, so a short window allows it, and the cost of that window is written down
  ([ADR 0016](adr/0016-refresh-token-rotation.md)).
- **Proving it, not claiming it.** At the point where the system got slow, the API processes were 190% busy and
  Postgres 10%, so the limit was Node's CPU and not the database, and no index was added. A profile showed a send
  taking 17 SQL round trips. Two redundant ones were removed (14 now), worth 2 to 4%, which is inside the noise of
  a shared machine, and the report says so. The bigger change it points at, passing the send's context to the
  fan-out instead of re-reading it, was not made. [docs/scaling.md](scaling.md) also covers what changes at 10x and
  100x.

## Results

Measured on one 2-core machine that also ran the load generator, Postgres and Redis:

| What | Result |
| --- | --- |
| Open sockets across 3 API instances | 5,000, every message crossing Redis |
| Messages lost or duplicated | none |
| Delivery latency | p50 10 ms, p99 38 ms |
| One of three instances killed mid-run | every affected client back and caught up in 4 s |
| Where it gets slow | past about 200 messages a second on those two cores, slow but not wrong |
| Cost of telemetry | about 1.5x the API's CPU per message with a Collector, 1.3x with none |

The unit and integration suites run against real Postgres, Redis and S3-compatible storage, and the same behaviour
suite runs on both backends. Production dependencies have no known vulnerabilities, and a secret scan of the whole
history found nothing.

## What I would do differently

- Write the ADR on the day of the decision. Four of the seventeen (idempotent sends, paging, refresh tokens and
  blocking) were written after the code and say so in their date line.
- Check the Compose profiles in CI from the first week. They are the part that was written but not run where it was
  measured, and it is the first thing a new reader tries.
- Make the fan-out change the load tests pointed at before adding anything else on top of it.

## What is not done

No hosted demo, no screenshots or video, no full-text search, and the Compose stack, nginx and the Grafana
dashboards were written and checked for syntax but not run with traffic in the environment where the numbers were
measured. [docs/roadmap.md](roadmap.md) lists them, and the [edge-case register](edge-cases.md) records every
judgement call.

## Stack

TypeScript, NestJS, Next.js, PostgreSQL with Drizzle, Redis with socket.io and BullMQ, S3-compatible storage,
OpenTelemetry with Tempo, Prometheus, Loki and Grafana, Docker Compose and nginx, Vitest, Playwright and k6,
GitHub Actions.
