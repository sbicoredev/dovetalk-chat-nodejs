import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { LoggerModule } from "nestjs-pino";

import { activeTraceIds } from "@dovetalk/telemetry";

import type { BaseEnv } from "./config.js";

const REQUEST_ID_PATTERN = /^[\w.:-]{1,100}$/u;

/** Uses the caller's request id when it looks sane, otherwise makes one. */
export function requestIdFrom(req: IncomingMessage, res?: ServerResponse): string {
  const header = req.headers["x-request-id"];
  const given = Array.isArray(header) ? header[0] : header;
  const id = given && REQUEST_ID_PATTERN.test(given) ? given : randomUUID();
  res?.setHeader("x-request-id", id);
  return id;
}

/**
 * Adds `trace_id` and `span_id` to a log line when it is written inside a span, so Loki can jump
 * to the trace and Tempo to the logs. The names match what the pino instrumentation adds, so a
 * line carries them once however the process was started (the instrumentation is off in tests and
 * when no OTLP endpoint is set; this is not).
 */
export function traceMixin(): { span_id?: string; trace_id?: string } {
  const ids = activeTraceIds();
  return ids ? { trace_id: ids.traceId, span_id: ids.spanId } : {};
}

export type LoggerSettings = Pick<BaseEnv, "LOG_LEVEL" | "LOG_PRETTY" | "APP_VERSION"> & {
  serviceName: string;
};

/** Structured JSON logs with secrets removed. Both apps use the same settings. */
export function createLoggerModule(settings: LoggerSettings) {
  return LoggerModule.forRoot({
    pinoHttp: {
      level: settings.LOG_LEVEL,
      mixin: traceMixin,
      base: { service: settings.serviceName, version: settings.APP_VERSION },
      genReqId: (req, res) => requestIdFrom(req, res),
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers.cookie",
          'res.headers["set-cookie"]',
          "req.body.password",
        ],
        censor: "[redacted]",
      },
      // Probes fire every few seconds and would drown the useful lines.
      autoLogging: { ignore: (req) => (req.url ?? "").startsWith("/health") },
      // The auth guard sets `req.user`. Logging the id ties a request to a person without logging a token.
      customProps: (req) => {
        const userId = (req as { user?: { id?: string } }).user?.id;
        return userId ? { userId } : {};
      },
      customLogLevel: (_req, res, error) => {
        if (error || res.statusCode >= 500) {
          return "error";
        }
        return res.statusCode >= 400 ? "warn" : "info";
      },
      ...(settings.LOG_PRETTY
        ? { transport: { target: "pino-pretty", options: { singleLine: true } } }
        : {}),
    },
  });
}
