# Architecture decision records

Short notes on the decisions that shaped the code: what was decided, what else was considered and what it
costs. Each has a status and a date. A decision that changes gets a new record that points back to the old one;
old records are not rewritten.

| #                                                      | Decision                                                      |
| ------------------------------------------------------ | ------------------------------------------------------------- |
| [0001](0001-two-deployables-shared-libraries.md)       | Two deployables (API, worker) that share domain libraries     |
| [0002](0002-drizzle-over-prisma.md)                    | Drizzle over Prisma                                           |
| [0003](0003-per-viewer-projection.md)                  | Per-viewer projection: every person sees their own ids        |
| [0004](0004-bullmq-over-rabbitmq.md)                   | BullMQ over RabbitMQ                                          |
| [0005](0005-dependency-policy.md)                      | Dependency policy and the recorded exceptions                 |
| [0006](0006-esm-and-internal-package-builds.md)        | ESM and how the internal packages are built                   |
| [0007](0007-one-conformance-suite-for-both-backends.md) | One conformance suite for the mock and the real API          |
| [0008](0008-biome-over-eslint-prettier.md)             | Biome (through Ultracite) over ESLint and Prettier            |
| [0009](0009-realtime-delivery-and-presence.md)         | Realtime delivery across instances, and presence in Redis     |
| [0010](0010-job-design-and-cleanup.md)                 | Job design and the cleanup rules                              |
| [0011](0011-session-handling-in-the-web-app.md)        | Session handling in the web app                               |
| [0012](0012-opentelemetry-stack.md)                    | The OpenTelemetry stack                                       |
| [0013](0013-scale-out-without-sticky-sessions.md)      | Scale out behind nginx with no sticky sessions                |
| [0014](0014-idempotency-keys-for-sends.md)             | Idempotent sends with a client-made key                       |
| [0015](0015-cursor-paging-over-offset.md)              | Cursor paging on the chat's sequence number                   |
| [0016](0016-refresh-token-rotation.md)                 | Short access tokens, rotating refresh tokens in a cookie      |
| [0017](0017-blocking-semantics.md)                     | What blocking does                                            |

The diagrams that show how these fit together are in [docs/architecture.md](../architecture.md). Gaps and
judgement calls found while building are in [docs/edge-cases.md](../edge-cases.md).
