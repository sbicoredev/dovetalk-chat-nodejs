import fs from "node:fs";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SpanKind } from "@dovetalk/telemetry";
import { startTestTelemetry, type TestTelemetry } from "@dovetalk/telemetry/testing";

import type { TestApp } from "./support/create-test-app.js";

/*
 * Why this file imports so little at the top.
 *
 * OpenTelemetry's instrumentations work by patching a library at the moment it is first loaded:
 * `pg`, `ioredis`, `express`, `pino`, `socket.io`, Nest. A library that is already loaded when
 * telemetry starts is never patched, and produces no spans. A static `import` runs before any code
 * in the file, so with `import { createTestApp } ...` at the top, `pg` would load first, telemetry
 * would start after it, and the trace would have no database spans and still look fine at a glance.
 *
 * So: the two telemetry modules above are safe (they only load the OpenTelemetry API and SDK). The
 * app and everything it uses, @dovetalk/core, @dovetalk/db, drizzle, supertest, are imported
 * dynamically below, after `startTestTelemetry()`. Do not add a static import of any of them here,
 * and keep `import type` for anything only used as a type. In production the same ordering comes
 * from `node --import ./dist/instrumentation.js dist/main.js`.
 */

type Span = ReturnType<TestTelemetry["finishedSpans"]>[number];
type Batches = Awaited<ReturnType<TestTelemetry["collectMetrics"]>>;

const REQUEST_ID = "req-otel-send-1";

const idOf = (span: Span) => span.spanContext().spanId;
const parentOf = (span: Span) => span.parentSpanContext?.spanId;

/** Whether `ancestor` is somewhere above `span`, however many spans (Express, Nest) lie between. */
function isDescendant(span: Span, ancestor: Span, all: Span[]): boolean {
  const byId = new Map(all.map((s) => [idOf(s), s]));
  let cursor: Span | undefined = span;
  for (let hops = 0; cursor && hops < 50; hops += 1) {
    const parent = parentOf(cursor);
    if (parent === idOf(ancestor)) {
      return true;
    }
    cursor = parent ? byId.get(parent) : undefined;
  }
  return false;
}

function metricNames(batches: Batches): Set<string> {
  return new Set(
    batches.flatMap((batch) =>
      batch.scopeMetrics.flatMap((scope) => scope.metrics.map((m) => m.descriptor.name)),
    ),
  );
}

/** The data points of the most recent export that has this metric. */
function latestPoints(batches: Batches, name: string) {
  for (const batch of [...batches].reverse()) {
    for (const scope of batch.scopeMetrics) {
      const metric = scope.metrics.find((m) => m.descriptor.name === name);
      if (metric) {
        return metric.dataPoints;
      }
    }
  }
  return [];
}

let telemetry: TestTelemetry;
let t: TestApp;

/**
 * Everything pino wrote to standard output (file descriptor 1), parsed. Pino writes with
 * `fs.write` through its own stream, so `process.stdout` never sees it.
 */
const stdoutLines: Record<string, unknown>[] = [];
const spies: { mockRestore: () => void }[] = [];

function keepJsonLines(data: unknown): number {
  const text = typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString("utf8");
  for (const line of text.split("\n")) {
    try {
      stdoutLines.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // Not one of pino's JSON lines.
    }
  }
  return text.length;
}

// What the one send produced.
let spans: Span[];
let traceSpans: Span[];
let server: Span;
let send: Span;
let traceId: string;

beforeAll(async () => {
  const realWrite = fs.write;
  const realWriteSync = fs.writeSync;
  spies.push(
    vi.spyOn(fs, "write").mockImplementation(((fd: number, data: unknown, ...rest: unknown[]) => {
      if (fd !== 1) {
        return (realWrite as (...args: unknown[]) => void)(fd, data, ...rest);
      }
      const written = keepJsonLines(data);
      const done = rest.at(-1);
      if (typeof done === "function") {
        (done as (error: null, written: number) => void)(null, written);
      }
    }) as typeof fs.write),
    vi
      .spyOn(fs, "writeSync")
      .mockImplementation(((fd: number, data: unknown, ...rest: unknown[]) =>
        fd === 1
          ? keepJsonLines(data)
          : (realWriteSync as (...args: unknown[]) => number)(
              fd,
              data,
              ...rest,
            )) as typeof fs.writeSync),
  );

  telemetry = startTestTelemetry("dovetalk-api-test");
  const { createTestApp } = await import("./support/create-test-app.js");
  const { RealtimeEvents } = await import("@dovetalk/core");
  t = await createTestApp({ LOG_LEVEL: "info" });

  // A real HTTP request from `fetch`: nothing instruments Node's fetch client, so the API's server
  // span is the root of its trace (supertest's client would be the root otherwise).
  const base = await t.listen();
  const me = await t.signUp();
  const chats = (await (await fetch(`${base}/chats`, { headers: me.bearer })).json()) as {
    id: string;
  }[];
  const chatId = chats[0]?.id;
  await t.app.get(RealtimeEvents).idle();
  telemetry.reset();
  stdoutLines.length = 0;

  const response = await fetch(`${base}/chats/${chatId}/messages`, {
    method: "POST",
    headers: { ...me.bearer, "content-type": "application/json", "x-request-id": REQUEST_ID },
    body: JSON.stringify({ kind: "text", text: "hello", clientId: "otel-1" }),
  });
  if (response.status !== 201) {
    throw new Error(`The send answered ${response.status}: ${await response.text()}`);
  }
  // The fan-out runs in the background after the response, and spans end when their work does.
  await t.app.get(RealtimeEvents).idle();
  await vi.waitFor(() => {
    if (!telemetry.finishedSpans().some((s) => s.kind === SpanKind.SERVER)) {
      throw new Error("The server span has not ended yet.");
    }
    if (!telemetry.logRecords().some((r) => r.body === "request completed")) {
      throw new Error("The request's log line has not arrived yet.");
    }
  });

  spans = telemetry.finishedSpans();
  send = spans.find((s) => s.name === "message.send") as Span;
  traceId = (send as Span | undefined)?.spanContext().traceId as string;
  traceSpans = spans.filter((s) => s.spanContext().traceId === traceId);
  server = traceSpans.find((s) => s.kind === SpanKind.SERVER) as Span;
});

afterAll(async () => {
  for (const spy of spies) {
    spy.mockRestore();
  }
  await t.close();
  await telemetry.shutdown();
});

describe("one message send is one trace", () => {
  it("is rooted at the HTTP server span, and message.send sits below it", () => {
    expect(send, spans.map((s) => s.name).join(", ")).toBeDefined();
    expect(server, "no server span in the send's trace").toBeDefined();
    expect(server.name).toBe("POST /chats/:chatId/messages");
    expect(parentOf(server)).toBeUndefined();
    expect(traceSpans.filter((s) => parentOf(s) === undefined)).toEqual([server]);
    expect(isDescendant(send, server, traceSpans)).toBe(true);
  });

  it("puts the database work, BEGIN to COMMIT, under message.send", () => {
    const queries = traceSpans.filter(
      (s) => s.attributes["db.system.name"] === "postgresql" && s.name.startsWith("pg.query:"),
    );
    const direct = queries
      .filter((s) => parentOf(s) === idOf(send))
      .map((s) => s.name.split(" ")[0]);
    // The transaction's statements, in the order they ran.
    expect(direct).toContain("pg.query:BEGIN");
    expect(direct).toContain("pg.query:UPDATE");
    expect(direct).toContain("pg.query:INSERT");
    expect(direct).toContain("pg.query:COMMIT");
    expect(direct.indexOf("pg.query:BEGIN")).toBeLessThan(direct.indexOf("pg.query:INSERT"));
    expect(direct.indexOf("pg.query:INSERT")).toBeLessThan(direct.lastIndexOf("pg.query:COMMIT"));
    // And no query is orphaned: each one is somewhere below the server span.
    for (const query of queries) {
      expect(isDescendant(query, server, traceSpans), query.name).toBe(true);
    }
  });

  it("makes the fan-out a child of message.send, with its own queries below it", () => {
    const fanout = traceSpans.find((s) => s.name === "realtime.fanout message:new");
    expect(fanout, traceSpans.map((s) => s.name).join(", ")).toBeDefined();
    expect(parentOf(fanout as Span)).toBe(idOf(send));
    const below = traceSpans.filter(
      (s) => s.name.startsWith("pg.query:") && parentOf(s) !== idOf(send),
    );
    expect(below.some((s) => isDescendant(s, fanout as Span, traceSpans))).toBe(true);
  });
});

describe("logs carry the trace", () => {
  it("sends the request's log line over OTLP with the trace id", () => {
    const record = telemetry
      .logRecords()
      .find((r) => r.body === "request completed" && r.spanContext?.traceId === traceId);
    expect(record, JSON.stringify(telemetry.logRecords().map((r) => r.body))).toBeDefined();
    expect(record?.spanContext?.spanId).toMatch(/^[0-9a-f]{16}$/u);
  });

  it("writes the same trace id on the line pino prints to stdout", async () => {
    const lineOf = () =>
      stdoutLines.find(
        (l) =>
          l.msg === "request completed" &&
          (l.req as { id?: string } | undefined)?.id === REQUEST_ID,
      );
    await vi.waitFor(() => expect(lineOf()).toBeDefined());
    const line = lineOf();
    expect(line?.trace_id).toBe(traceId);
    expect(line?.span_id).toMatch(/^[0-9a-f]{16}$/u);
  });
});

describe("metrics", () => {
  it("counts the message, times the fan-out and reports the pool", async () => {
    const batches = await telemetry.collectMetrics();
    const names = metricNames(batches);
    for (const name of [
      "messages_sent_total",
      "message_fanout_duration_ms",
      "db_pool_connections",
    ]) {
      expect(names.has(name), `${name} is missing from ${[...names].join(", ")}`).toBe(true);
    }

    const sent = latestPoints(batches, "messages_sent_total").find(
      (p) => p.attributes.kind === "text",
    );
    expect(sent?.value).toBe(1);

    const fanout = latestPoints(batches, "message_fanout_duration_ms").find(
      (p) => p.attributes.event === "message:new",
    );
    expect((fanout?.value as { count: number } | undefined)?.count).toBe(1);

    const states = latestPoints(batches, "db_pool_connections").map((p) => p.attributes.state);
    expect(states.sort()).toEqual(["idle", "total", "waiting"]);
  });
});
