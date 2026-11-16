import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { DiagConsoleLogger, DiagLogLevel, diag } from "@opentelemetry/api";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis";
import { NestInstrumentation } from "@opentelemetry/instrumentation-nestjs-core";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";
import { PinoInstrumentation } from "@opentelemetry/instrumentation-pino";
import { SocketIoInstrumentation } from "@opentelemetry/instrumentation-socket.io";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchLogRecordProcessor, type LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { type IMetricReader, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { BatchSpanProcessor, type SpanProcessor } from "@opentelemetry/sdk-trace";
import { register as registerImportHooks } from "import-in-the-middle/register-hooks.mjs";

import { batchOptionsFromEnv, exportCooldownFromEnv, guardExporter } from "./exporters.js";
import { registerTelemetryShutdown } from "./shutdown.js";

type Env = Record<string, string | undefined>;

export interface StartTelemetryOptions {
  env?: Env;
  /** `deployment.environment`. Defaults to NODE_ENV. */
  environment?: string;
  /** Defaults to a random id, or HOSTNAME when set (a container id is a good instance id). */
  instanceId?: string;
  /** Replace the exporters. Tests use these to keep everything in memory. Passing any turns telemetry on. */
  logRecordProcessors?: LogRecordProcessor[];
  metricReaders?: IMetricReader[];
  serviceName: string;
  serviceVersion?: string;
  spanProcessors?: SpanProcessor[];
}

export interface TelemetryHandle {
  /** Exports what is buffered and stops. Safe to call twice. */
  shutdown: () => Promise<void>;
}

const ENDPOINT_VARIABLES = [
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
] as const;

const FALSE_VALUES = new Set(["false", "0", "no", "off"]);
const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);

/**
 * Whether telemetry is switched on. The rules, in order:
 *
 * 1. `OTEL_SDK_DISABLED=true` (the standard switch) or `TELEMETRY_ENABLED=false`: off.
 * 2. `TELEMETRY_ENABLED=true`: on, sending to the default local endpoint (http://localhost:4318)
 *    unless an endpoint is set.
 * 3. Otherwise on exactly when an OTLP endpoint is set. A laptop or a test run with nothing
 *    listening therefore costs nothing and prints no export errors.
 *
 * To send to Grafana Cloud, set the standard variables: OTEL_EXPORTER_OTLP_ENDPOINT,
 * OTEL_EXPORTER_OTLP_HEADERS (`Authorization=Basic ...`) and OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf.
 */
export function telemetryEnabled(env: Env = process.env): boolean {
  if (TRUE_VALUES.has((env.OTEL_SDK_DISABLED ?? "").toLowerCase())) {
    return false;
  }
  const switchValue = (env.TELEMETRY_ENABLED ?? "").toLowerCase();
  if (FALSE_VALUES.has(switchValue)) {
    return false;
  }
  if (TRUE_VALUES.has(switchValue)) {
    return true;
  }
  return ENDPOINT_VARIABLES.some((name) => Boolean(env[name]));
}

/** Health probes fire every few seconds. Tracing them would bury the traces that matter. */
const QUIET_PATHS = ["/health", "/metrics", "/favicon.ico"];

function isQuiet(request: IncomingMessage): boolean {
  const url = request.url ?? "";
  return request.method === "OPTIONS" || QUIET_PATHS.some((path) => url.startsWith(path));
}

/** Socket events that fire constantly and say little. They are counted, not traced. */
const NOISY_SOCKET_EVENTS = ["typing", "presence", "ping", "pong"];

let started: TelemetryHandle | null = null;

/**
 * Starts OpenTelemetry for this process: traces, metrics and logs over OTLP, with automatic
 * instrumentation for HTTP, Express, Nest, pg, ioredis, socket.io and pino.
 *
 * Call it once, from an `instrumentation` file loaded before anything else:
 *
 *     node --import ./dist/instrumentation.js dist/main.js
 *
 * It has to run first because the instrumentations work by patching a library as it is loaded.
 * Returns `null` and changes nothing when telemetry is off (see `telemetryEnabled`).
 */
export function startTelemetry(options: StartTelemetryOptions): TelemetryHandle | null {
  const env = options.env ?? process.env;
  const overridden = Boolean(
    options.spanProcessors || options.metricReaders || options.logRecordProcessors,
  );
  if (started) {
    return started;
  }
  if (!(overridden || telemetryEnabled(env))) {
    return null;
  }

  if (env.OTEL_LOG_LEVEL) {
    const level = DiagLogLevel[env.OTEL_LOG_LEVEL.toUpperCase() as keyof typeof DiagLogLevel];
    diag.setLogger(new DiagConsoleLogger(), level ?? DiagLogLevel.INFO);
  }

  // Lets the instrumentations also patch libraries that are loaded as ES modules. This is what
  // `@opentelemetry/instrumentation/hook.mjs` does through `module.register()`, which Node 26
  // deprecates (DEP0205) and which runs the loader on a second thread. import-in-the-middle's
  // `registerHooks` entry installs the same hook synchronously, on this thread, with no warning.
  // Node >= 26 is required by the repo's `engines`, and that is a version it supports. It has to run
  // before the application's imports do.
  registerImportHooks();

  const exportIntervalMillis = Number(env.OTEL_METRIC_EXPORT_INTERVAL) || 10_000;
  const cooldownMs = exportCooldownFromEnv(env);
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      "service.name": options.serviceName,
      "service.version": options.serviceVersion ?? env.APP_VERSION ?? "dev",
      "service.instance.id": options.instanceId ?? env.HOSTNAME ?? randomUUID(),
      "deployment.environment": options.environment ?? env.NODE_ENV ?? "development",
    }),
    spanProcessors: options.spanProcessors ?? [
      new BatchSpanProcessor({
        exporter: guardExporter(new OTLPTraceExporter(), cooldownMs),
        ...batchOptionsFromEnv(env, "OTEL_BSP"),
      }),
    ],
    metricReaders: options.metricReaders ?? [
      new PeriodicExportingMetricReader({
        exporter: guardExporter(new OTLPMetricExporter(), cooldownMs),
        exportIntervalMillis,
      }),
    ],
    logRecordProcessors: options.logRecordProcessors ?? [
      new BatchLogRecordProcessor({
        exporter: guardExporter(new OTLPLogExporter(), cooldownMs),
        ...batchOptionsFromEnv(env, "OTEL_BLRP"),
      }),
    ],
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: isQuiet }),
      new ExpressInstrumentation(),
      new NestInstrumentation(),
      // Only commands that run inside a request or a job get a span. Without this the blocking
      // reads BullMQ keeps open, and the presence heartbeat, would each become a span.
      new PgInstrumentation({ requireParentSpan: true }),
      new IORedisInstrumentation({ requireParentSpan: true }),
      new SocketIoInstrumentation({
        emitIgnoreEventList: NOISY_SOCKET_EVENTS,
        onIgnoreEventList: NOISY_SOCKET_EVENTS,
      }),
      // Adds trace_id, span_id and trace_flags to every log line, and sends the lines over OTLP.
      new PinoInstrumentation(),
    ],
  });
  sdk.start();

  let stopping: Promise<void> | null = null;
  started = {
    shutdown() {
      stopping ??= sdk.shutdown();
      return stopping;
    },
  };
  registerTelemetryShutdown(started.shutdown);
  return started;
}

/** For tests that start telemetry more than once in a process. */
export function resetTelemetryForTests(): void {
  started = null;
}
