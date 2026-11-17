import { randomBytes } from "node:crypto";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { activeTraceIds, SpanKind, withSpan } from "@dovetalk/telemetry";
import { startTestTelemetry, type TestTelemetry } from "@dovetalk/telemetry/testing";

import type { Infra } from "./support/harness.js";

/*
 * Import order matters in this file. The instrumentations patch `pg` and `ioredis` (which BullMQ
 * uses) as they are first loaded, so telemetry starts first and everything that loads them is
 * imported dynamically after it. A static import of the harness, @dovetalk/core or bullmq here
 * would load them before the patch and the trace would silently lose its database spans. See the
 * note at the top of apps/api/test/telemetry.test.ts.
 */

type Span = ReturnType<TestTelemetry["finishedSpans"]>[number];
const idOf = (span: Span) => span.spanContext().spanId;
const traceOf = (span: Span) => span.spanContext().traceId;
const parentOf = (span: Span) => span.parentSpanContext?.spanId;

let telemetry: TestTelemetry;
let infra: Infra;
beforeAll(async () => {
  telemetry = startTestTelemetry("dovetalk-worker-test");
  const { createInfra } = await import("./support/harness.js");
  infra = await createInfra();
});
afterAll(async () => {
  await infra.close();
  await telemetry.shutdown();
});

const open: { close: () => Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((resource) => resource.close()));
});

describe("a bot reply continues the trace of the request that caused it", () => {
  it("links the producer span, both job runs and the reply's own send in one trace", async () => {
    const harness = await import("./support/harness.js");
    const worker = await harness.startWorker(infra);
    open.push(worker.app);
    const api = await harness.startApiSide(infra);
    open.push(api);

    const s = harness.servicesOf(api);
    const me = await harness.makePerson(s.db);
    const bot = await harness.makeBot(s.db, { name: "Bo Bot" });
    const [contactId] = await harness.befriend(s.db, me, [bot]);
    const { chat } = await s.chats.create(me.id, {
      type: "direct",
      contactId: contactId as string,
    });
    await worker.quiet();
    telemetry.reset();

    // Stands in for the HTTP request: the one span the send happens under.
    await withSpan("POST /chats/:chatId/messages", { kind: SpanKind.SERVER }, () =>
      s.messages.send(me.id, chat.id, { kind: "text", text: "ping", clientId: "trace-1" }),
    );

    const finished = (name: string) => telemetry.finishedSpans().filter((x) => x.name === name);
    await harness.eventually(() => finished("bot-replies process").length >= 2, {
      message: "The worker did not run both jobs.",
      timeoutMs: 15_000,
    });

    const request = finished("POST /chats/:chatId/messages")[0] as Span;
    const [publish] = finished("bot-replies publish");
    expect(publish, "no producer span").toBeDefined();
    expect(publish?.kind).toBe(SpanKind.PRODUCER);
    expect(traceOf(publish as Span)).toBe(traceOf(request));

    const runs = finished("bot-replies process");
    expect(new Set(runs.map((run) => run.attributes["job.name"]))).toEqual(
      new Set(["reply", "typing"]),
    );
    for (const run of runs) {
      expect(run.kind, run.name).toBe(SpanKind.CONSUMER);
      // The same trace as the request, hanging directly under the producer span.
      expect(traceOf(run)).toBe(traceOf(request));
      expect(parentOf(run)).toBe(idOf(publish as Span));
    }

    // The reply is sent by the worker through the same MessagesService, inside the job's span.
    const reply = runs.find((run) => run.attributes["job.name"] === "reply") as Span;
    await harness.eventually(
      () =>
        telemetry
          .finishedSpans()
          .some((x) => x.name === "message.send" && parentOf(x) === idOf(reply)),
      { message: "The reply's send is not under the job's span." },
    );
  }, 30_000);
});

describe("runWorker spans", () => {
  async function queueAndWorker(process: (job: { data: unknown }) => Promise<unknown>) {
    const { Queue } = await import("bullmq");
    const { queueConnection } = await import("@dovetalk/core");
    const { runWorker } = await import("../src/jobs/run-worker.js");
    const prefix = `t-${randomBytes(4).toString("hex")}`;
    const name = `plain-${randomBytes(3).toString("hex")}`;
    const queue = new Queue<{ n: number; trace?: Record<string, string> }>(name, {
      connection: queueConnection(infra.redisUrl, "test:queue"),
      prefix,
      defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: true },
    });
    open.push({ close: () => queue.obliterate({ force: true }).then(() => queue.close()) });
    const worker = runWorker<{ n: number; trace?: Record<string, string> }, string>({
      queue: name,
      prefix,
      connection: queueConnection(infra.redisUrl, "test:worker"),
      concurrency: 1,
      process,
      onDeadLetter: async () => undefined,
    });
    open.push(worker);
    await worker.waitUntilReady();
    return { queue, name };
  }

  it("still runs a job that carries no trace, in a trace of its own", async () => {
    const ran = vi.fn(async () => "done");
    const { queue, name } = await queueAndWorker(ran);

    await queue.add("task", { n: 1 });
    await vi.waitFor(() => expect(ran).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    await vi.waitFor(
      () => expect(telemetry.finishedSpans().some((x) => x.name === `${name} process`)).toBe(true),
      { timeout: 10_000 },
    );

    const run = telemetry.finishedSpans().find((x) => x.name === `${name} process`) as Span;
    expect(run.kind).toBe(SpanKind.CONSUMER);
    expect(parentOf(run)).toBeUndefined();
    expect(run.status.code).not.toBe(2);
  });

  it("marks the span failed when the job throws, and counts the run as an error", async () => {
    const { queue, name } = await queueAndWorker(async () => {
      throw new Error("job broke");
    });

    await queue.add("task", { n: 2 });
    await vi.waitFor(
      () => expect(telemetry.finishedSpans().some((x) => x.name === `${name} process`)).toBe(true),
      { timeout: 10_000 },
    );
    const run = telemetry.finishedSpans().find((x) => x.name === `${name} process`) as Span;
    expect(run.status.code).toBe(2);
    expect(run.events.some((event) => event.name === "exception")).toBe(true);

    const batches = await telemetry.collectMetrics();
    const jobs = batches
      .at(-1)
      ?.scopeMetrics.flatMap((scope) => scope.metrics)
      .find((metric) => metric.descriptor.name === "jobs_total");
    const point = jobs?.dataPoints.find(
      (p) => p.attributes.queue === name && p.attributes.outcome === "error",
    );
    expect(point).toBeDefined();
    // The job's name is `job_name`. A label called `job` would be overwritten by Prometheus'
    // own `job` label (the service name) and every job would look the same.
    expect(point?.attributes.job_name).toBe("task");
    expect(point?.attributes).not.toHaveProperty("job");
  });
});

describe("runWorker log lines", () => {
  it("writes the done and failed lines of a job under that job's trace", async () => {
    const { Logger } = await import("@nestjs/common");
    const { Queue } = await import("bullmq");
    const { queueConnection } = await import("@dovetalk/core");
    const { runWorker } = await import("../src/jobs/run-worker.js");

    // What each line was written under: the trace ids active at the moment of the call.
    const lines: { message: string; ids: ReturnType<typeof activeTraceIds> }[] = [];
    // Nest calls `logger.log({ ...fields }, "text")`, so the text is the string among the arguments.
    const record = (...args: unknown[]) => {
      lines.push({
        message: args.filter((a) => typeof a === "string").join(" "),
        ids: activeTraceIds(),
      });
    };
    Logger.overrideLogger({ log: record, warn: record, error: record });

    try {
      const prefix = `t-${randomBytes(4).toString("hex")}`;
      const name = `logs-${randomBytes(3).toString("hex")}`;
      const queue = new Queue<{ fail?: boolean }>(name, {
        connection: queueConnection(infra.redisUrl, "test:queue"),
        prefix,
        defaultJobOptions: { attempts: 1, removeOnComplete: true, removeOnFail: true },
      });
      open.push({ close: () => queue.obliterate({ force: true }).then(() => queue.close()) });
      const worker = runWorker<{ fail?: boolean }, string>({
        queue: name,
        prefix,
        connection: queueConnection(infra.redisUrl, "test:worker"),
        concurrency: 1,
        process: async (job) => {
          if (job.data.fail) {
            throw new Error("job broke");
          }
          return "done";
        },
        onDeadLetter: async () => undefined,
      });
      open.push(worker);
      await worker.waitUntilReady();

      await queue.add("fine", {});
      await queue.add("broken", { fail: true });
      await vi.waitFor(
        () => {
          expect(lines.some((l) => l.message.includes("Job fine done"))).toBe(true);
          expect(lines.some((l) => l.message.includes("Job broken failed for good"))).toBe(true);
        },
        { timeout: 10_000 },
      );

      // Both jobs' spans have ended by now. Each line carries the ids of its own job's span.
      for (const [jobName, text] of [
        ["fine", "Job fine done"],
        ["broken", "Job broken failed for good"],
      ] as const) {
        const line = lines.find((l) => l.message.includes(text));
        const run = telemetry
          .finishedSpans()
          .find((x) => x.name === `${name} process` && x.attributes["job.name"] === jobName);
        expect(run, jobName).toBeDefined();
        expect(line?.ids, `${text} was written outside the job's trace`).toEqual({
          traceId: (run as Span).spanContext().traceId,
          spanId: (run as Span).spanContext().spanId,
        });
      }
    } finally {
      Logger.overrideLogger(true);
    }
  });
});

describe("QueueDepth", () => {
  it("reads the queues when metrics are collected, and stops when the app stops", async () => {
    const { QueueDepth } = await import("../src/jobs/queue-depth.js");
    const counts = vi.fn(async () => ({ waiting: 2, active: 1, delayed: 0, failed: 0 }));
    const queues = {
      botReplies: { name: "bot-replies", getJobCounts: counts },
      maintenance: { name: "maintenance", getJobCounts: counts },
    };
    const depth = new QueueDepth(queues as never);
    depth.onModuleInit();

    const batches = await telemetry.collectMetrics();
    const points = batches
      .at(-1)
      ?.scopeMetrics.flatMap((scope) => scope.metrics)
      .find((metric) => metric.descriptor.name === "queue_jobs")?.dataPoints;
    expect(points).toHaveLength(8);
    expect(
      points?.find((p) => p.attributes.queue === "bot-replies" && p.attributes.state === "waiting")
        ?.value,
    ).toBe(2);

    depth.onModuleDestroy();
    const before = counts.mock.calls.length;
    await telemetry.collectMetrics();
    await telemetry.collectMetrics();
    expect(counts.mock.calls.length).toBe(before);
    expect(() => depth.onModuleDestroy()).not.toThrow();
  });
});
