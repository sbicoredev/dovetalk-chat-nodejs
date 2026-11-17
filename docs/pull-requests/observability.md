# Observability with OpenTelemetry

## Goal

Traces, metrics and logs from the API and the worker, correlated, with the dashboards and alerts defined as
code. One message send should be one trace across both services, its log lines should carry
that trace's id, and a latency spike should link to a trace.

The pieces, how to read them and how they were checked are in
[docs/observability.md](../observability.md). The reasons, and where the usual advice was not
followed, are in [ADR 0012](../adr/0012-opentelemetry-stack.md).

## What changed

**`packages/telemetry` (new).** The OpenTelemetry Node SDK with OTLP/HTTP exporters, loaded before the app by
`node --import ./dist/instrumentation.js` in both apps. Automatic instrumentation for HTTP, Express, Nest,
pg, ioredis, socket.io and pino. Helpers for our own spans and metrics (`withSpan`, `dovetalkMetrics`) and for
running code inside a captured trace context. The telemetry package is a leaf in the module boundaries.

- Telemetry is **off unless an OTLP endpoint is set** (`TELEMETRY_ENABLED=false` forces it off).
- `OTEL_BSP_*` and `OTEL_BLRP_*` are read, so the queue and batch sizes can be tuned.
- An export guard (`guardExporter`, `TELEMETRY_EXPORT_COOLDOWN_MS`, default 30000) drops batches early when
  the Collector is unreachable, which cut the memory peaks.

**`packages/core`, `apps/api`, `apps/worker`.**

- Spans for `message.send`, `realtime.fanout` and `bot-replies publish`. The API puts the W3C `traceparent` in
  the job's data and the worker's `bot-replies process` span continues it, so a send is one trace across
  both services.
- Metrics: `ws_connections`, `messages_sent_total`, `message_fanout_duration_ms`, `socket_events_total`,
  `bot_reply_duration_ms`, `job_duration_ms`, `jobs_total`, `queue_jobs`, `db_pool_connections`,
  `db_pool_max`.
- The worker writes a job's `done` and `failed` lines under that job's trace (BullMQ reports them after the
  span ended).

**`ops/docker` and `docker-compose.yml`.** Collector (with the `spanmetrics` connector for RED metrics and
exemplars), Tempo, Prometheus (remote-write receiver, exemplar storage), Loki, Grafana with provisioned
datasources linked to each other, `postgres_exporter` and `redis_exporter`, under the `observability` profile.
Four dashboards generated from `ops/docker/grafana/generate-dashboards.mjs` and committed (API rate, errors,
duration; Realtime; Jobs and queues; Postgres and Redis), and two alert rules in `alerts.yml`.

**CI.** A `compose-config` job: `docker compose config -q` for every profile, the Collector's `validate`,
`promtool check config`, and a check that the committed dashboards equal what the generator writes. It has
never run in GitHub Actions (see "Not done"); its commands were run by hand here.

**Docs.** `docs/observability.md`, ADR 0012, two new exception rows in ADR 0005, the README, and the telemetry
sections of the three `.env.example` files.

## How to test

```bash
# Static checks and suites (Postgres, Redis and an S3 endpoint are needed for core and api)
pnpm install --frozen-lockfile
pnpm --filter "./packages/*" build
pnpm lint && pnpm lint:boundaries && pnpm typecheck
pnpm --filter @dovetalk/telemetry test
pnpm --filter @dovetalk/core test
pnpm --filter @dovetalk/worker test
pnpm --filter @dovetalk/api test

# The stack
cp .env.example .env
OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 \
  docker compose --profile app --profile observability up -d --build
# Grafana: http://localhost:3030 (no login), folder "Dovetalk". Prometheus alerts: http://localhost:9090/alerts
```

Then send a message in the app and follow it, see "Follow one message from the browser to the database" in
observability.md. `docker compose --profile observability pull` is the first check of the image tags, which
no registry was reachable to confirm.

## Checklist

A tick means it was run and its value was checked, not that something exists.

**Tasks**

- [x] Shared OTel bootstrap in `packages/telemetry`, loaded from `instrumentation.ts` in both apps. BullMQ:
      manual spans with `traceparent` in the job data (a maintained instrumentation for BullMQ 6 was not
      found at the time; `bullmq-otel` was found late and not tried, see below).
- [x] Logs: pino with trace and span ids, exported over OTLP to Loki. Checked against a real Loki: the three
      log lines of one message carry exactly the trace id that was sent, and their span ids are real spans
      in Tempo.
- [x] Custom metrics, with exemplars. The exemplars are on the Collector's span-metrics histogram, because
      the JavaScript metrics SDK cannot attach them to a histogram. They were read back from Prometheus and
      their trace ids exist in Tempo.
- [x] `ops/docker/`: Collector, Tempo, Prometheus, Loki, Grafana with provisioned datasources and dashboards
      (JSON in git), two alert rules. **Verified up to the data-source level, UI not exercised:** the
      provisioning files parse and every datasource reference points at a uid that exists, and all 28
      dashboard queries return series with their legend labels from a running Prometheus. Grafana itself was
      never started.
- [x] Compose profile `observability`; trace to logs and metrics to trace links are configured in the
      datasource provisioning. **Configured, not exercised in the Grafana UI.**
- [x] Config switch for Grafana Cloud (OTLP endpoint and headers from the environment). **Not tried against a
      real Grafana Cloud stack.**
- [ ] Stretch: browser tracing with the OTel web SDK. **Not built.** A trace starts at the API.
- [~] `docs/observability.md`: written, with the metric list and how to follow a message from the API to the
      database. **No screenshots** (nothing was ever rendered, and none are faked; a shot list is at the end
      of the page). The "browser to the database" part is limited by the missing browser tracing.

**Tests**

- [x] A test boots the app with an in-memory span exporter and asserts the send-message span tree and that
      logs carry trace ids (`apps/api/test/telemetry.test.ts`), and the worker continues the request's trace
      and still runs a job that has none (`apps/worker/test/telemetry.test.ts`).

**Overall**

- [~] `docker compose --profile observability up`: send a message, find its trace in Grafana, jump to its logs,
      see the dashboards populated. **Met only with the endpoint one-liner**, and only checked **natively**:
      with `--profile observability` alone the stack starts and the dashboards are empty, because the apps
      send nothing until `OTEL_EXPORTER_OTLP_ENDPOINT` is set (decision A below). No Docker daemon was ever
      available, so no container was started, and the Grafana UI was not opened. What was run: the real apps
      against native builds of the same Collector, Tempo, Prometheus and Loki versions.
- [x] Overhead of instrumentation noted in the docs: about 1.5x the API's CPU per message with a Collector and
      about 1.3x with none (observability.md, "Overhead").

## Decisions and deviations

**A. Compose leaves `OTEL_EXPORTER_OTLP_ENDPOINT` empty.** A missing Collector is silent (no crash, no export
error, no extra log line, checked under load) but telemetry is **not cheap**: about 1.5x the API's CPU per
message with a Collector and about 1.3x with none, and an absent Collector costs no more than a present one. A
default of "on" would charge that to every `--profile app` run, the CI conformance and end-to-end jobs
included. The one-liner is `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 docker compose --profile
app --profile observability up -d` (or that line in `.env`). So the intended `docker compose --profile
observability up` is met only with the one-liner, and the README, `.env.example`, `docker-compose.yml` and the
docs say so. `TELEMETRY_ENABLED=false` is the opt-out.

**Bugs found by verification during the work** (each has a test or a check, and none was visible from
reading the code):

- The worker's `done` and `failed` lines had no `trace_id`, so trace to logs found nothing for them.
- The `job` metric label was overwritten by Prometheus's own `job` label, so every job read as the service
  name; the label is now `job_name`.
- `OTEL_BSP_*` and `OTEL_BLRP_*` were silently ignored, because `startTelemetry` builds the processors and
  the SDK reads those variables only when it builds them itself.
- With an endpoint set and no Collector, memory grew. A guard skips exports for 30 s after one fails.
  It reduces the peaks (490 MB against 668 MB, refused); it does not remove the variance.

**BullMQ.** The spans are written by hand. `bullmq-otel` 2.0.1 (the BullMQ authors' package, peer
`bullmq >=6`) was found late and **not tried**; replacing tested spans late would change the
trace shape. It is on the roadmap.

**Other findings.**

- A bot-reply job for a chat that does not exist is not a failure (result `nobody`); a malformed chat id
  makes it fail. The failing-job check used a malformed id.
- The ES module hook is `registerHooks` (import-in-the-middle's `register-hooks.mjs`), not
  `module.register()`, which Node 26 deprecates.
- Grafana `13.3.1` could not be confirmed (`dl.grafana.com` was blocked and GitHub has no release assets for
  it), and no image tag was checked against a registry. Both are exception rows in ADR 0005, and every tag is
  a variable in `docker-compose.yml`. The six other versions were confirmed as GitHub release assets and
  their binaries ran. The 17 npm dependencies of `packages/telemetry` each equal the latest on npm (checked
  again at the end).

## What was verified by running, and what was not

**Run, with the real code on a native stack** (no Docker; Node 26.13.1; Collector 0.165.0, Tempo 3.1.1,
Prometheus v3.16.0, Loki 3.7.10, `postgres_exporter` v0.20.1, `redis_exporter` v1.97.0; one machine with 1 CPU
and 4 GB for the smoke checks and a 2 CPU, 8 GB machine for the overhead tables):

- One message is one trace of 98 spans with one root across both services; its three log lines in Loki carry
  the trace id that was sent, and their span ids are real spans in Tempo.
- A real failing job (malformed chat id) failed twice. Its final `failed` line carries the failing span's trace
  and span id, the span has `STATUS_CODE_ERROR`, and `jobs_total{job_name="reply",outcome="error"}` is 2.
- All 28 dashboard queries return series with their legend labels, and `job_name` holds real job names.
- Sampling `parentbased_traceidratio` at 0.1 keeps about 10% (sampled span metric 182.9 against unsampled
  1,791.5, a ratio of 0.102; the driver sent 1,945, a ratio of 0.094).
- Silence with a refused and with an unresolvable endpoint, under load: 0 warn or error lines in the API and
  the worker, with telemetry demonstrably active. No dropped spans at about 4,000 spans a second (41 sends a
  second); the SDK does log `Dropped N spans because maxQueueSize reached` at `warn` (seen with
  `OTEL_BSP_MAX_QUEUE_SIZE=64`), so the silence means something.
- `ApiLatencyP95High` went pending and then **firing** after its ten minutes, at a real value of 4,128 ms (a 690 s
  run with 96 clients on a 1 CPU, 4 GB machine that also ran the whole stack and the driver: 32,745 sends, none
  failed; this is that box saturated, not a capacity). `ApiErrorRateHigh` stayed inactive in that run.
- `ApiErrorRateHigh` went pending and then **firing** at a real value of 0.33 (40 successful sends a second
  plus 20 uploads a second failing with 500 because the S3 store was stopped).
- `promtool check rules`, the Collector's `validate`, `docker compose config -q` for four profiles (Compose
  v2.40.3, no daemon), and the committed dashboards equal the generator's output.
- Final checks for this PR, run at the end: see "Checks" below.

**Not run:** the Grafana UI (provisioning load, dashboards rendering, the three data links), any Docker image
or container, the image tags, the `compose-config` CI job in GitHub Actions, Alertmanager, Grafana Cloud, and
spans at 10,000 a second or more.

## Checks

Run at the end on Node 26.13.1 and pnpm 12.18.0 (one machine, 1 CPU, 4 GB; Postgres 16, Redis and
moto as the S3 endpoint):

| Check | Result |
| --- | --- |
| `pnpm --filter "./packages/*" build` | exit 0 |
| `pnpm lint` | exit 0, 12 warnings, all in `apps/web` (the known ones) |
| `pnpm lint:boundaries` | no dependency violations (438 modules, 1,431 dependencies) |
| `pnpm typecheck` | exit 0 |
| `packages/telemetry` | 16 tests passed (2 files) |
| `packages/core` | 431 tests passed (26 files) |
| `apps/worker` | 45 tests passed (5 files) |
| `apps/api` | 389 tests passed (28 files) |

No test failed. Postgres 16 was used locally; CI runs on 18.

## Not done and roadmap

- **Browser tracing** (a stretch goal): a trace starts at the API.
- About **8 Express middleware spans per request** carry no information (`request handler - {/*splat}` and
  friends, also an `http_route` of `{/*splat}` in the span metrics).
- The **`ioredis` connect spans** (`hello`, `client`, `info`) sit under the first publish. With the `pg` spans
  that is **about 98 spans per send**.
- **Structured-metadata volume in Loki**: resource attributes such as `process.command_args` and the response
  headers pino logs are kept on every line.
- **Try `bullmq-otel`** 2.0.1 and compare the trace with the one in observability.md; delete our spans if it
  matches.
- **The Grafana UI was never exercised and there are no screenshots.** Someone who can run Docker should
  start the stack, take the six screenshots listed at the end of observability.md and check the three data
  links.
- The **export guard does not fully flatten memory** when there is no Collector. If the Collector is down on
  purpose, set `TELEMETRY_ENABLED=false`.
- **Alertmanager is not wired.** The rules show in Prometheus.
- **Spans were not tested at 10,000 a second.** A send makes about 98 spans, so about 135 sends a second on a
  2 CPU machine is on that order; the `OTEL_BSP_MAX_QUEUE_SIZE` dial exists.
- With `OTEL_LOG_LEVEL` set the apps print **two harmless startup warnings** (`Current logger will be
  overwritten`), because `packages/telemetry/src/start.ts` and `NodeSDK` both register the diagnostic logger.
- **Image tags and Grafana 13.3.1 are unchecked** against a registry. The first
  `docker compose --profile observability pull` will confirm or correct them.
- The CI job `compose-config` has **never run in GitHub Actions**.
- Overhead numbers are from one small machine shared with the load driver; they should be repeated on
  separate machines, saying whether telemetry was on.
