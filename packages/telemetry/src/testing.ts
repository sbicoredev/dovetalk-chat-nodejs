import {
  InMemoryLogRecordExporter,
  type ReadableLogRecord,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
  type ResourceMetrics,
} from "@opentelemetry/sdk-metrics";
import type { ReadableSpan } from "@opentelemetry/sdk-trace";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace";

import { resetTelemetryForTests, startTelemetry, type TelemetryHandle } from "./start.js";

export interface TestTelemetry {
  /** Forces a metrics export and returns every batch exported so far. */
  collectMetrics: () => Promise<ResourceMetrics[]>;
  /** Spans that have ended, oldest first. */
  finishedSpans: () => ReadableSpan[];
  /** Log records sent to the OTel logs pipeline. */
  logRecords: () => ReadableLogRecord[];
  reset: () => void;
  shutdown: () => Promise<void>;
}

/**
 * Starts telemetry with everything kept in memory. Call it before the code under test is loaded,
 * because the instrumentations patch libraries as they load. One per process.
 */
export function startTestTelemetry(serviceName = "dovetalk-test"): TestTelemetry {
  resetTelemetryForTests();
  const spans = new InMemorySpanExporter();
  const logs = new InMemoryLogRecordExporter();
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter: metrics,
    // Exports only when asked to (forceFlush): a test controls when.
    exportIntervalMillis: 3_600_000,
  });
  const handle: TelemetryHandle | null = startTelemetry({
    serviceName,
    serviceVersion: "test",
    environment: "test",
    spanProcessors: [new SimpleSpanProcessor({ exporter: spans })],
    logRecordProcessors: [new SimpleLogRecordProcessor({ exporter: logs })],
    metricReaders: [reader],
  });
  return {
    finishedSpans: () => spans.getFinishedSpans(),
    logRecords: () => logs.getFinishedLogRecords(),
    async collectMetrics() {
      await reader.forceFlush();
      return metrics.getMetrics();
    },
    reset() {
      spans.reset();
      logs.reset();
      metrics.reset();
    },
    shutdown: () => handle?.shutdown() ?? Promise.resolve(),
  };
}
