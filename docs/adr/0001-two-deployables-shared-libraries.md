# 0001. Two deployables that share domain libraries

- Status: accepted
- Date: 2026-11-13

## Context

Dovetalk needs HTTP and socket.io handling, and background work (bot replies, cleanup). The two have
different scaling needs: sockets scale with connected users, jobs scale with queue depth. Running jobs
inside the API process would couple them, and a slow job could starve the event loop that serves sockets.

## Decision

Two NestJS apps in one monorepo: `apps/api` and `apps/worker`. They deploy and scale on their own and
never import each other. Everything both need lives in `packages/` (`contracts`, `db`, `core`,
`telemetry`). Dependencies point one way: apps depend on packages, `core` depends on `db` and
`contracts`, `contracts` depends on nothing.

The worker is a Nest standalone application with no user-facing server. It writes to Postgres through
the same `core` services as the API and emits socket events through the Redis emitter, so it needs no
socket server and never calls the API. Each business rule has exactly one implementation, in `core`.

`dependency-cruiser` enforces these boundaries in CI (`pnpm lint:boundaries`).

## Consequences

- Scaling and deploying each side is independent. Sticky sessions are not needed.
- Code both apps need must move into a package before the second app can use it. That is deliberate friction.
- This is not microservices. There is one database and one deploy pipeline, with two processes.
