// Writes the Grafana dashboards in ./dashboards as JSON. The JSON is committed, this is how it is
// made:  node ops/docker/grafana/generate-dashboards.mjs
// Edit here, regenerate, commit both. Grafana loads the folder through provisioning, read-only.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const out = join(dirname(fileURLToPath(import.meta.url)), "dashboards");
mkdirSync(out, { recursive: true });

const PROM = { type: "prometheus", uid: "prometheus" };
const SERVER = 'service_name="dovetalk-api", span_kind="SPAN_KIND_SERVER"';

// refId is A, B, C... within one panel.
const target = (expr, legend, index, extra = {}) => ({
  datasource: PROM,
  expr,
  legendFormat: legend,
  refId: String.fromCharCode(65 + index),
  ...extra,
});

function panel({
  title,
  description,
  unit = "short",
  targets,
  x,
  y,
  w = 12,
  h = 8,
  type = "timeseries",
  stack = false,
}) {
  return {
    id: 0,
    type,
    title,
    description,
    datasource: PROM,
    gridPos: { x, y, w, h },
    fieldConfig: {
      defaults: {
        unit,
        custom: stack ? { stacking: { mode: "normal" }, fillOpacity: 30 } : { fillOpacity: 10 },
      },
      overrides: [],
    },
    options: { legend: { displayMode: "list", placement: "bottom" }, tooltip: { mode: "multi" } },
    targets: targets.map(([expr, legend, extra], index) => target(expr, legend, index, extra)),
  };
}

function dashboard(uid, title, description, panels) {
  panels.forEach((p, index) => {
    p.id = index + 1;
  });
  return {
    uid,
    title,
    description,
    tags: ["dovetalk"],
    schemaVersion: 39,
    version: 1,
    editable: false,
    refresh: "10s",
    time: { from: "now-30m", to: "now" },
    timezone: "browser",
    panels,
  };
}

const quantile = (q, metric, by = "le", filter = "") =>
  `histogram_quantile(${q}, sum by (${by}) (rate(${metric}_bucket${filter}[1m])))`;

const dashboards = [
  dashboard(
    "dovetalk-api-red",
    "API: rate, errors, duration",
    "Server spans of dovetalk-api, from the Collector's span metrics. Dots on the latency panel are exemplars: click one to open its trace.",
    [
      panel({
        title: "Requests per second",
        description: "By route.",
        unit: "reqps",
        x: 0,
        y: 0,
        targets: [
          [
            `sum by (http_route) (rate(traces_span_metrics_calls_total{${SERVER}}[1m]))`,
            "{{http_route}}",
          ],
        ],
      }),
      panel({
        title: "Error rate",
        description:
          "Share of requests that failed with a 5xx. 4xx answers are the client's doing and do not count. Zero while nothing fails; no data while there is no traffic.",
        unit: "percentunit",
        x: 12,
        y: 0,
        targets: [
          [
            `(sum(rate(traces_span_metrics_calls_total{${SERVER}, status_code="STATUS_CODE_ERROR"}[1m])) or vector(0)) / sum(rate(traces_span_metrics_calls_total{${SERVER}}[1m]))`,
            "errors",
          ],
        ],
      }),
      panel({
        title: "Latency p50 / p95 / p99",
        description: "Milliseconds. The exemplars link to traces.",
        unit: "ms",
        x: 0,
        y: 8,
        w: 24,
        targets: [
          [quantile(0.5, "traces_span_metrics_duration_milliseconds", "le", `{${SERVER}}`), "p50"],
          [
            quantile(0.95, "traces_span_metrics_duration_milliseconds", "le", `{${SERVER}}`),
            "p95",
            { exemplar: true },
          ],
          [quantile(0.99, "traces_span_metrics_duration_milliseconds", "le", `{${SERVER}}`), "p99"],
        ],
      }),
      panel({
        title: "p95 by route",
        unit: "ms",
        x: 0,
        y: 16,
        targets: [
          [
            quantile(
              0.95,
              "traces_span_metrics_duration_milliseconds",
              "le, http_route",
              `{${SERVER}}`,
            ),
            "{{http_route}}",
          ],
        ],
      }),
      panel({
        title: "Responses by status",
        unit: "reqps",
        x: 12,
        y: 16,
        stack: true,
        targets: [
          [
            `sum by (http_response_status_code) (rate(traces_span_metrics_calls_total{${SERVER}}[1m]))`,
            "{{http_response_status_code}}",
          ],
        ],
      }),
    ],
  ),
  dashboard("dovetalk-realtime", "Realtime", "Sockets, fan-out and events.", [
    panel({
      title: "WebSocket connections",
      description: "Summed over API instances.",
      x: 0,
      y: 0,
      targets: [
        ["sum(ws_connections)", "total"],
        ["sum by (service_instance_id) (ws_connections)", "{{service_instance_id}}"],
      ],
    }),
    panel({
      title: "Messages sent per second",
      unit: "ops",
      x: 12,
      y: 0,
      targets: [["sum by (kind) (rate(messages_sent_total[1m]))", "{{kind}}"]],
    }),
    panel({
      title: "Fan-out latency p50 / p95 / p99",
      description: "From a message being stored until its events reached Redis.",
      unit: "ms",
      x: 0,
      y: 8,
      targets: [
        [quantile(0.5, "message_fanout_duration_ms"), "p50"],
        [quantile(0.95, "message_fanout_duration_ms"), "p95"],
        [quantile(0.99, "message_fanout_duration_ms"), "p99"],
      ],
    }),
    panel({
      title: "Socket events per second",
      description: "Out is what the servers published, in is what clients sent.",
      unit: "ops",
      x: 12,
      y: 8,
      stack: true,
      targets: [
        ["sum by (event, direction) (rate(socket_events_total[1m]))", "{{event}} {{direction}}"],
      ],
    }),
  ]),
  dashboard("dovetalk-jobs", "Jobs and queues", "BullMQ queues and the worker.", [
    panel({
      title: "Jobs waiting, active, delayed, failed",
      description: "Counts live in Redis, so every worker replica reports the same: max, not sum.",
      x: 0,
      y: 0,
      targets: [["max by (queue, state) (queue_jobs)", "{{queue}} {{state}}"]],
    }),
    panel({
      title: "Jobs finished per second",
      unit: "ops",
      x: 12,
      y: 0,
      stack: true,
      targets: [["sum by (queue, outcome) (rate(jobs_total[1m]))", "{{queue}} {{outcome}}"]],
    }),
    panel({
      title: "Job duration p95",
      unit: "ms",
      x: 0,
      y: 8,
      targets: [
        [quantile(0.95, "job_duration_ms", "le, queue, job_name"), "{{queue}} {{job_name}}"],
      ],
    }),
    panel({
      title: "Bot reply duration p50 / p95",
      description:
        "Time the reply job takes to choose and send the answer. The reply's 2.4 s delay is not part of it.",
      unit: "ms",
      x: 12,
      y: 8,
      targets: [
        [quantile(0.5, "bot_reply_duration_ms"), "p50"],
        [quantile(0.95, "bot_reply_duration_ms"), "p95"],
      ],
    }),
    panel({
      title: "Failed job runs",
      description: "A run that threw. BullMQ retries it, so one job can count more than once.",
      x: 0,
      y: 16,
      targets: [
        [
          'sum by (queue, job_name) (increase(jobs_total{outcome="error"}[5m]))',
          "{{queue}} {{job_name}}",
        ],
      ],
    }),
  ]),
  dashboard(
    "dovetalk-data",
    "Postgres and Redis",
    "The apps' own pool usage next to the servers' view.",
    [
      panel({
        title: "Connection pool, per instance",
        description: "Connections held by each API and worker process.",
        x: 0,
        y: 0,
        targets: [
          [
            'sum by (service_name, service_instance_id) (db_pool_connections{state="total"})',
            "{{service_name}} {{service_instance_id}}",
          ],
        ],
      }),
      panel({
        title: "Requests waiting for a connection",
        description: "Above zero for long means DATABASE_POOL_MAX is too low.",
        x: 12,
        y: 0,
        targets: [
          ['sum by (service_name) (db_pool_connections{state="waiting"})', "{{service_name}}"],
        ],
      }),
      panel({
        title: "Postgres connections",
        x: 0,
        y: 8,
        targets: [["sum by (state) (pg_stat_activity_count)", "{{state}}"]],
      }),
      panel({
        title: "Postgres transactions per second",
        unit: "ops",
        x: 12,
        y: 8,
        targets: [
          ["sum(rate(pg_stat_database_xact_commit[1m]))", "commits"],
          ["sum(rate(pg_stat_database_xact_rollback[1m]))", "rollbacks"],
        ],
      }),
      panel({
        title: "Redis clients and memory",
        x: 0,
        y: 16,
        targets: [
          ["redis_connected_clients", "clients"],
          ["redis_memory_used_bytes / 1024 / 1024", "memory MiB"],
        ],
      }),
      panel({
        title: "Redis commands per second",
        unit: "ops",
        x: 12,
        y: 16,
        targets: [["rate(redis_commands_processed_total[1m])", "commands"]],
      }),
    ],
  ),
];

for (const d of dashboards) {
  writeFileSync(join(out, `${d.uid}.json`), `${JSON.stringify(d, null, 2)}\n`);
}
console.log(`Wrote ${dashboards.length} dashboards to ${out}`);
