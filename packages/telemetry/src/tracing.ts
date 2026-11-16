import {
  type Attributes,
  type Context,
  context,
  propagation,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";

/** The name every span and metric of this project is made under (the instrumentation scope). */
export const SCOPE_NAME = "dovetalk";

export interface SpanSettings {
  attributes?: Attributes;
  kind?: SpanKind;
  /** Start the span under this context instead of the active one. */
  parent?: Context;
}

/**
 * Runs `work` inside a new active span and ends it. A thrown error is recorded on the span, marks
 * it failed and is rethrown unchanged. Without a started SDK this costs a no-op span.
 */
export function withSpan<T>(
  name: string,
  settings: SpanSettings,
  work: (span: Span) => Promise<T> | T,
): Promise<T> {
  const tracer = trace.getTracer(SCOPE_NAME);
  return tracer.startActiveSpan(
    name,
    { kind: settings.kind ?? SpanKind.INTERNAL, attributes: settings.attributes },
    settings.parent ?? context.active(),
    async (span) => {
      try {
        return await work(span);
      } catch (error) {
        span.recordException(error instanceof Error ? error : new Error(String(error)));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/** A W3C trace context as plain strings, small enough to travel inside a job's data. */
export type TraceCarrier = Record<string, string>;

/**
 * The active trace as a carrier, or `undefined` when nothing is being traced. Put it in a job's
 * data so the worker's spans continue the trace of the request that caused the job.
 */
export function currentTraceCarrier(): TraceCarrier | undefined {
  const carrier: TraceCarrier = {};
  propagation.inject(context.active(), carrier);
  return carrier.traceparent ? carrier : undefined;
}

/** The context a carrier describes. An empty or missing carrier gives the active context back. */
export function contextFromCarrier(carrier: TraceCarrier | undefined): Context {
  return carrier?.traceparent ? propagation.extract(context.active(), carrier) : context.active();
}

/** The context that is active right now, to be passed to `runInContext` later. */
export function captureContext(): Context {
  return context.active();
}

/**
 * Runs `work` with `captured` as the active context. For code that runs after a span has ended and
 * outside the callback that made it, such as an event handler: the log lines it writes then still
 * carry the span's trace and span ids, so a trace links to them.
 */
export function runInContext<T>(captured: Context, work: () => T): T {
  return context.with(captured, work);
}

/** The ids of the active span, for log lines and error pages. `undefined` outside a span. */
export function activeTraceIds(): { spanId: string; traceId: string } | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  return spanContext && trace.isSpanContextValid(spanContext)
    ? { traceId: spanContext.traceId, spanId: spanContext.spanId }
    : undefined;
}
