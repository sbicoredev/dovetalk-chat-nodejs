# 0012. The OpenTelemetry stack

- Status: accepted
- Date: 2026-11-17

## Context

The system has to be observable: traces, metrics and logs from the API and the worker, correlated, with
dashboards as code. The pieces, how to read them and how they were checked are in
[docs/observability.md](../observability.md). This record is the reasons, and the places where
the usual advice was not followed.

## Decisions

### OTLP to a Collector, not a `/metrics` endpoint

The apps push traces, metrics and logs over OTLP/HTTP to a Collector, which fans out to Tempo, Prometheus
and Loki. One protocol carries all three signals, the logs arrive with their trace ids, and moving to Grafana
Cloud is a change of endpoint and headers. A `/metrics` endpoint would have covered metrics only, and would
have needed a second path for logs and a third for traces. The price is that Prometheus has to run with the
remote-write receiver and exemplar storage switched on (`docker-compose.yml` does), and that the apps' own
Prometheus names come from the Collector's mapping, not from us (`_ms` durations, the `job_name` label, below).

### RED metrics and exemplars from the Collector's `spanmetrics` connector

The JavaScript metrics SDK cannot attach exemplars to a histogram, and a latency spike that cannot be opened
as a trace is half a dashboard. The connector turns every server span into `traces_span_metrics_calls_total`
and a duration histogram, with an exemplar per bucket. The API dashboard and both alerts read those. The cost
is that they count **sampled** spans, so sampling changes the absolute rates (observability.md, "Sampling").
The apps' own `http_server_request_duration_seconds` is unsampled and stays available.

### BullMQ: spans written by hand, the trace context carried in the job's data

A job should continue the trace of the request that queued it. `packages/core` opens a producer span when the
API queues a job and puts the W3C `traceparent` into the job's data (`currentTraceCarrier`); the worker opens
its consumer span as a child of it (`contextFromCarrier`, `runWorker`). One message send is one trace across
both services.

What was checked about the alternatives (`npm view`, 2026-11-16):

- `@appsignal/opentelemetry-instrumentation-bullmq` **0.9.0**, last published 2026-09-10. It is maintained, but
  its peer range is `bullmq ^2 || ^3 || ^4 || ^5`, so it does not support BullMQ 6, which we use, and it is
  built on `@opentelemetry/instrumentation ^0.221` while the SDK here is 0.301. Not an option.
- `bullmq-otel` **2.0.1** (the BullMQ authors' package, MIT, peer `bullmq >=6`, last published 2026-08-18).
  **This is the better fit and the earlier sessions did not know about it.** It does not patch BullMQ: it
  implements the `telemetry` option BullMQ itself has, and BullMQ makes the spans and carries the context
  in the job's options. It was **not tried**. Replacing the hand-written spans is a behaviour change (span
  names, attributes, how a `addBulk` of two jobs is traced, whether the worker's "done" lines keep their
  trace), and the code uses tested hand-written spans. It is on the roadmap list: try it, compare
  the trace with the one in observability.md, and delete our code if it matches.

### Logs get their trace id from pino's instrumentation; the worker writes two lines under a saved context

See observability.md, "How logs find their trace". BullMQ announces `completed` and `failed` after the
processor returned and its span ended, so `runWorker` saves each job's context and writes those two lines
inside it. This was found by checking, not by reading: the lines had no `trace_id` and trace-to-logs found
nothing. A test fails without the fix.

### The ES module hook: `registerHooks`, not `module.register()`

The instrumentations patch a library as it is loaded. For ES modules that needs a loader hook.
`@opentelemetry/instrumentation/hook.mjs` installs it with `module.register()`, which Node 26 deprecates
(DEP0205) and which runs the loader on a second thread. `import-in-the-middle`'s `register-hooks.mjs`
installs the same hook synchronously on the main thread with no warning. The repo requires Node >= 26.

### Metric names: durations end in `_ms` and carry no unit; the job label is `job_name`

Both are consequences of how the Collector writes Prometheus names, and both were found when a check found
the wrong value, not the wrong name. The reasons are in observability.md. A test asserts `job_name` and that
`job` is absent.

### Telemetry is off unless an endpoint is set, and Compose does not set one

`startTelemetry` does nothing when no OTLP endpoint is configured (and `TELEMETRY_ENABLED=false` forces it
off). The intent was for `docker compose --profile observability up` to be enough on its own, and the first
idea was to default the endpoint to `http://otel-collector:4318` in Compose. It was decided with
measurements, because the condition was "if a missing Collector is silent and cheap".

- **Silent: yes.** With the endpoint set and nothing listening (connection refused), or with a name that does
  not resolve, there is no crash, no export error and no extra log line. Checked on the final build, under
  load (about 1,400 and 1,700 sends in 30 seconds): no warn or error line in the API's or the worker's log,
  with telemetry demonstrably running (about 97% of the API's lines carried a `trace_id`). That is at the
  default log level. With `OTEL_LOG_LEVEL` set the SDK reports its own problems, and also prints two
  harmless warnings at startup (our code and `NodeSDK` both register the diagnostic logger).
- **Cheap: no, and not because of the missing Collector.** On one 2 CPU, 8 GB machine, API CPU per message
  sent was 3.90 ms with telemetry off and 5.76 ms with the whole stack (+48%), and 5.05 ms with nothing
  listening (+29%, connection refused). Against a Collector that discards everything it was 5.15 ms (+40%);
  that figure is from an earlier set of runs, where telemetry off read 3.69 ms, and is only comparable with
  that set. So telemetry costs about **1.5x** the API's CPU per message with a Collector and about **1.3x**
  with none. An absent Collector costs no more than a present one. The cost is creating about 98 spans and
  the log records per message. Sampling recovers about a third of it (all traces +59%, 10% of traces +40%)
  and even with no trace kept it is still +33%, so most of the rest is the instrumentation patches, the log
  records and the metrics, not the spans (observability.md, "Overhead"). A default of "on" would charge it
  to everyone who runs `--profile app`, including the CI conformance and end-to-end jobs, to save one
  environment variable for the people who want Grafana.
- **Bounded: not at first.** With nothing listening, memory grew (475 to 667 MB over five rounds under load,
  against 379 to 446 MB with a Collector and 336 to 378 MB with telemetry off), and throughput slid. Heap reports showed it in the old generation of the JS
  heap (176 to 402 MB over five rounds, against a flat 200 MB with a Collector): an exporter whose Collector is
  down keeps each batch for its whole retry cycle (5 attempts with backoff, about 13 seconds), so spans and
  log records survive long enough to be promoted and the heap stretches. Two changes, in `packages/telemetry`,
  with tests:
  - **An export guard** (`guardExporter`). After an export fails, the next exports for 30 seconds fail at
    once without trying (`TELEMETRY_EXPORT_COOLDOWN_MS`, 0 turns it off). A batch is dropped early instead of
    late; when the cooldown is over the next batch is tried, and one that gets through ends it. With it the
    no-Collector case ran at 421 to 490 MB (peak 490, against 668 without the guard; 446 with a working Collector).
    It is **not as steady as a working Collector**: one run with an unresolvable name still spiked to 571 MB.
    The guard reduces the peaks and the growth, it does not remove
    the variance. Its effect on CPU is within the noise (5.05 against 5.28 ms per message, the ranges overlap).
  - **`OTEL_BSP_*` and `OTEL_BLRP_*` work.** These are the standard queue and batch settings, and the SDK reads
    them only when it builds the processors itself. `startTelemetry` builds them (to pick the proto
    exporters), so the variables did nothing, and the docs of every OTel distribution say they work. They are
    read now (`batchOptionsFromEnv`). Nothing changes unless someone sets them.

  So: **Compose leaves the endpoint empty.** `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318 docker
  compose --profile app --profile observability up -d`, or the same line in `.env`, is the one-liner.
  `TELEMETRY_ENABLED=false` stays as the opt-out either way.

### Dashboards are generated JSON

`ops/docker/grafana/generate-dashboards.mjs` writes the four dashboards. The JSON is committed, because
Grafana loads files, and the `compose-config` CI job fails if a committed file differs from what the script
writes, so a hand edit of one does not survive. Panels, queries and units are one place to read.

### Image versions, and how they were confirmed

The environment this was built in could not reach Docker Hub, quay.io, ghcr.io, the GitHub API or
`dl.grafana.com`, and had no Docker daemon. So the versions were confirmed by other means, and some were not.

| Image | Tag | Confirmed how |
| --- | --- | --- |
| OpenTelemetry Collector contrib | 0.165.0 | The release asset exists on GitHub (`opentelemetry-collector-releases`, tag v0.165.0). Nothing newer was found by probing asset URLs: patch +1 to +12, minor +1 to +3, major +1. The binary was run (`validate`, then the pipeline). |
| Tempo | 3.1.1 | Same method, asset exists, nothing newer; binary run with `-target=all`. |
| Prometheus | v3.16.0 | Same; binary run, `promtool` used. |
| Loki | 3.7.10 | Same; binary run. |
| postgres_exporter | v0.20.1 | Same; binary run. |
| redis_exporter | v1.97.0 | Same; binary run. |
| Grafana | 13.3.1 | **Unverified.** Grafana's binaries are on `dl.grafana.com`, which was blocked, and GitHub has no release assets for it. 13.3.1 is the number the first prompt gave. It is an **exception to the dependency policy** (see [0005](0005-dependency-policy.md)), and the Grafana UI was never run. |

**The image tags themselves were not checked against any registry** (a release asset existing on GitHub
does not prove that the image was published with that tag). `docker compose config` does not pull, so it
cannot catch a wrong tag either. The first `docker compose --profile observability pull` will. Every tag is
a variable (`OTEL_COLLECTOR_IMAGE`, `TEMPO_IMAGE`, ...), so correcting one needs no code change.
"Nothing newer" is a statement about the probes, and a release that GitHub lists under another asset name
would have been missed.

The npm side has no exception: the 17 dependencies and peer dependencies of `packages/telemetry` each equal
the latest version on npm (`npm view`, 2026-11-17).

## Consequences

- Telemetry costs about 1.5x the API's CPU per message with a Collector and about 1.3x with none. An absent
  Collector costs no more than a present one. Sampling is the dial, and it recovers about a third of the
  cost. Whoever runs a load test should say whether telemetry was on.
- Whether spans are dropped under heavy load with a working Collector is only partly known. Nothing was
  dropped at about 4,000 spans a second (a short run on a 1 CPU machine, SDK logging at `warn`, which does
  report a drop: it was seen with a deliberately tiny queue). The rate the 2 CPU machine reached (about 135 sends a second, on the order of
  10,000 spans a second) was not tested for drops. `OTEL_BSP_MAX_QUEUE_SIZE` is the dial.
- Docs and dashboards depend on the Collector's naming. Pointing the apps straight at Grafana Cloud loses the
  RED dashboard unless the Collector stays in front.
- Follow-ups, none blocking: try `bullmq-otel` (above); Express middleware spans (8 per request, no
  information) and the `ioredis` connect spans under the first publish; the structured metadata Loki keeps on
  every line (process and response headers); browser tracing (a stretch goal); open the Grafana UI and take
  the screenshots.
