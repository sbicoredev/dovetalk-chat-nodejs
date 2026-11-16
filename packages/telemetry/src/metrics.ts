import {
  type Attributes,
  type Counter,
  type Histogram,
  type Meter,
  metrics,
  type ObservableResult,
  type UpDownCounter,
} from "@opentelemetry/api";

import { SCOPE_NAME } from "./tracing.js";

/**
 * Bucket edges for every duration in milliseconds: a fast query up to a slow retry.
 * One set keeps the panels comparable.
 */
export const DURATION_BUCKETS_MS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];

/**
 * The instruments this project records. They are made on first use, so importing this file costs
 * nothing, and with no SDK started every call does nothing.
 *
 * Names are the ones the dashboards use. Durations carry their unit in the name (`_ms`) and have
 * no OTel unit, so the Collector does not add a second suffix when it turns them into Prometheus
 * names.
 */
export interface DovetalkMetrics {
  /** Time a bot-reply job spends choosing and sending the reply. */
  botReplyDuration: Histogram;
  /** One run of one job, by queue, job name and outcome. */
  jobDuration: Histogram;
  jobs: Counter;
  /** Time from the send committing to its events reaching Redis, per message. */
  messageFanoutDuration: Histogram;
  /** A person or a bot sent a message (after a replay check: a replay is not counted). */
  messagesSent: Counter;
  /** Socket.io events that left the servers (`direction=out`) or arrived (`in`), by event name. */
  socketEvents: Counter;
  /** Open socket.io connections on this instance. Sum across instances for the total. */
  wsConnections: UpDownCounter;
}

let cached: DovetalkMetrics | undefined;

export function meter(): Meter {
  return metrics.getMeter(SCOPE_NAME);
}

export function dovetalkMetrics(): DovetalkMetrics {
  if (cached) {
    return cached;
  }
  const m = meter();
  const durationAdvice = { advice: { explicitBucketBoundaries: DURATION_BUCKETS_MS } };
  cached = {
    messagesSent: m.createCounter("messages_sent_total", {
      description: "Messages stored, by kind.",
    }),
    messageFanoutDuration: m.createHistogram("message_fanout_duration_ms", {
      description: "Milliseconds from a message being stored to its events being published.",
      ...durationAdvice,
    }),
    botReplyDuration: m.createHistogram("bot_reply_duration_ms", {
      description: "Milliseconds a bot-reply job takes to choose and send the reply.",
      ...durationAdvice,
    }),
    jobDuration: m.createHistogram("job_duration_ms", {
      description: "Milliseconds one job run took, by queue, job_name and outcome.",
      ...durationAdvice,
    }),
    jobs: m.createCounter("jobs_total", {
      description: "Job runs finished, by queue, job_name and outcome.",
    }),
    socketEvents: m.createCounter("socket_events_total", {
      description: "Socket.io events, by event name and direction.",
    }),
    wsConnections: m.createUpDownCounter("ws_connections", {
      description: "Open WebSocket connections on this instance.",
    }),
  };
  return cached;
}

export interface Observation {
  attributes?: Attributes;
  value: number;
}

/**
 * Registers a gauge that is read when metrics are collected. `read` may be async. A failure in it
 * skips that collection and is reported to `onError`, never thrown into the SDK.
 */
export function observeGauge(
  name: string,
  description: string,
  read: () => Promise<Observation[]> | Observation[],
  onError?: (error: unknown) => void,
): () => void {
  const gauge = meter().createObservableGauge(name, { description });
  const callback = async (result: ObservableResult) => {
    try {
      for (const { value, attributes } of await read()) {
        result.observe(value, attributes);
      }
    } catch (error) {
      onError?.(error);
    }
  };
  gauge.addCallback(callback);
  return () => gauge.removeCallback(callback);
}
