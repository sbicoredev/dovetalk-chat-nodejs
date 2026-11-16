import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  activeTraceIds,
  captureContext,
  contextFromCarrier,
  currentTraceCarrier,
  runInContext,
  SpanKind,
  withSpan,
} from "../src/index.js";
import { telemetryEnabled } from "../src/start.js";
import { startTestTelemetry, type TestTelemetry } from "../src/testing.js";

let telemetry: TestTelemetry;
beforeAll(() => {
  telemetry = startTestTelemetry();
});
afterAll(() => telemetry.shutdown());

describe("trace context in job data", () => {
  it("continues the producer's trace in the consumer, as a child", async () => {
    const carrier = await withSpan("produce", { kind: SpanKind.PRODUCER }, () =>
      currentTraceCarrier(),
    );
    expect(carrier?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/u);

    await withSpan(
      "consume",
      { kind: SpanKind.CONSUMER, parent: contextFromCarrier(carrier) },
      () => undefined,
    );
    const [produce, consume] = ["produce", "consume"].map((name) =>
      telemetry.finishedSpans().find((s) => s.name === name),
    );
    expect(consume?.spanContext().traceId).toBe(produce?.spanContext().traceId);
    expect(consume?.parentSpanContext?.spanId).toBe(produce?.spanContext().spanId);
  });

  it("records a failure on the span and rethrows it", async () => {
    await expect(
      withSpan("boom", {}, () => {
        throw new Error("nope");
      }),
    ).rejects.toThrow("nope");
    await vi.waitFor(() =>
      expect(telemetry.finishedSpans().some((s) => s.name === "boom")).toBe(true),
    );
    const span = telemetry.finishedSpans().find((s) => s.name === "boom");
    expect(span?.status, JSON.stringify(span?.status)).toMatchObject({ code: 2 });
    expect(span?.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("works with no carrier", () => {
    expect(contextFromCarrier(undefined)).toBeDefined();
  });
});

describe("a captured context", () => {
  it("gives code that runs after the span ended the span's trace ids", async () => {
    let captured: ReturnType<typeof captureContext> | undefined;
    let during: ReturnType<typeof activeTraceIds>;
    await withSpan("short-lived", {}, () => {
      captured = captureContext();
      during = activeTraceIds();
    });
    expect(during).toBeDefined();
    // The span has ended and nothing is active any more...
    expect(activeTraceIds()).toBeUndefined();
    // ...but code run in the captured context still sees the ended span's ids.
    expect(runInContext(captured as NonNullable<typeof captured>, () => activeTraceIds())).toEqual(
      during,
    );
    expect(activeTraceIds()).toBeUndefined();
  });
});

describe("telemetryEnabled", () => {
  it("is off by default and on with an endpoint", () => {
    expect(telemetryEnabled({})).toBe(false);
    expect(telemetryEnabled({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://x:4318" })).toBe(true);
  });
  it("obeys the switches", () => {
    expect(telemetryEnabled({ TELEMETRY_ENABLED: "true" })).toBe(true);
    expect(
      telemetryEnabled({ TELEMETRY_ENABLED: "false", OTEL_EXPORTER_OTLP_ENDPOINT: "http://x" }),
    ).toBe(false);
    expect(
      telemetryEnabled({ OTEL_SDK_DISABLED: "true", OTEL_EXPORTER_OTLP_ENDPOINT: "http://x" }),
    ).toBe(false);
  });
});
