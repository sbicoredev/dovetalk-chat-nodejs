Labels: good first issue
# Try `bullmq-otel` in place of the hand-written job spans

The worker's spans and the `traceparent` that links a job to the request that caused it are written by hand and
tested ([ADR 0012](../../docs/adr/0012-opentelemetry-stack.md)). A maintained package, `bullmq-otel`, was found late and
not tried.

**Idea.** Wire it in on a branch, compare the span names, attributes and parent-child links with the trace shown in
`docs/observability.md`, and delete our code if the result is the same.

**Start here.** `packages/telemetry`, `apps/worker/src/jobs`, `apps/api/test/telemetry.test.ts`.

**Done when.** The span-tree test passes unchanged, or the differences are written down in the ADR.
