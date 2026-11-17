import { randomBytes } from "node:crypto";

import { Logger } from "@nestjs/common";
import { type Job, Queue, type Worker } from "bullmq";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { queueConnection } from "@dovetalk/core";
import { createTestRedis } from "@dovetalk/testkit";

import { runWorker } from "../src/jobs/run-worker.js";
import { eventually } from "./support/harness.js";

interface Data {
  n: number;
}

let redisUrl: string;
let flush: () => Promise<void>;
beforeAll(async () => {
  // The tests fail jobs on purpose; the log lines for that are noise here.
  Logger.overrideLogger(false);
  const redis = await createTestRedis();
  ({ url: redisUrl, flush } = redis);
});
afterAll(() => flush());

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** A queue of its own, in which a job gets two attempts and almost no wait between them. */
async function setup(process: (job: Job<Data>) => Promise<unknown>) {
  const prefix = `t-${randomBytes(4).toString("hex")}`;
  const name = "run-worker-test";
  const queue = new Queue<Data>(name, {
    connection: queueConnection(redisUrl, "test:queue"),
    prefix,
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "fixed", delay: 20 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  });
  closers.push(() => queue.obliterate({ force: true }).then(() => queue.close()));

  const deadLetters: { id: string | undefined; message: string }[] = [];
  const worker: Worker<Data> = runWorker<Data, string>({
    queue: name,
    prefix,
    connection: queueConnection(redisUrl, "test:worker"),
    concurrency: 1,
    process,
    onDeadLetter: async (job, error) => {
      deadLetters.push({ id: job.id, message: error.message });
    },
  });
  closers.push(() => worker.close());
  await worker.waitUntilReady();
  return { queue, deadLetters };
}

const settled = (queue: Queue<Data>) => async () => {
  const counts = await queue.getJobCounts("active", "waiting", "delayed");
  return counts.active + counts.waiting + counts.delayed === 0;
};

describe("runWorker dead letters", () => {
  it("calls onDeadLetter once, after the last attempt, and keeps the job in the failed set", async () => {
    const attempts = vi.fn(async () => {
      throw new Error("always broken");
    });
    const { queue, deadLetters } = await setup(attempts);

    await queue.add("task", { n: 1 }, { jobId: "dead-1" });
    await eventually(() => deadLetters.length > 0, { message: "No dead letter arrived." });
    // Give a wrongly repeated call the time to show itself.
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(attempts).toHaveBeenCalledTimes(2);
    expect(deadLetters).toEqual([{ id: "dead-1", message: "always broken" }]);
    expect(await queue.getFailedCount()).toBe(1);
  });

  it("does not call it for a job that succeeds", async () => {
    const attempts = vi.fn(async () => "fine");
    const { queue, deadLetters } = await setup(attempts);

    await queue.add("task", { n: 2 });
    await eventually(() => attempts.mock.calls.length === 1);
    await eventually(settled(queue));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(deadLetters).toHaveLength(0);
    expect(await queue.getFailedCount()).toBe(0);
  });

  it("does not call it for a job that fails once and then succeeds", async () => {
    let calls = 0;
    const flaky = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("first try fails");
      }
      return "second time lucky";
    });
    const { queue, deadLetters } = await setup(flaky);

    await queue.add("task", { n: 3 });
    await eventually(() => flaky.mock.calls.length === 2, { message: "There was no second try." });
    await eventually(settled(queue));
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(deadLetters).toHaveLength(0);
    expect(await queue.getFailedCount()).toBe(0);
  });

  it("survives an onDeadLetter that throws, and keeps taking jobs", async () => {
    const seen: number[] = [];
    const prefix = `t-${randomBytes(4).toString("hex")}`;
    const queue = new Queue<Data>("throwing-cleanup", {
      connection: queueConnection(redisUrl, "test:queue"),
      prefix,
      defaultJobOptions: { attempts: 1, removeOnComplete: true },
    });
    closers.push(() => queue.obliterate({ force: true }).then(() => queue.close()));
    const worker = runWorker<Data, string>({
      queue: "throwing-cleanup",
      prefix,
      connection: queueConnection(redisUrl, "test:worker"),
      concurrency: 1,
      process: async (job) => {
        seen.push(job.data.n);
        if (job.data.n === 1) {
          throw new Error("no");
        }
      },
      onDeadLetter: async () => {
        throw new Error("cleanup failed too");
      },
    });
    closers.push(() => worker.close());
    await worker.waitUntilReady();

    await queue.add("task", { n: 1 });
    await queue.add("task", { n: 2 });

    await eventually(() => seen.length === 2, { message: "The worker stopped taking jobs." });
  });
});

describe("runWorker job log lines", () => {
  /** The structured object of every line the worker logged, with the message that went with it. */
  function captureLogs() {
    const lines: { level: "log" | "warn" | "error"; message: string; attempt: unknown }[] = [];
    const record = (level: "log" | "warn" | "error") =>
      vi
        .spyOn(Logger.prototype, level)
        .mockImplementation((payload: unknown, message?: unknown) => {
          const fields = (payload ?? {}) as { attempt?: unknown };
          lines.push({ level, message: String(message), attempt: fields.attempt });
        });
    const spies = [record("log"), record("warn"), record("error")];
    closers.push(async () => {
      for (const spy of spies) {
        spy.mockRestore();
      }
    });
    return lines;
  }

  it("numbers a first try that succeeds as attempt 1", async () => {
    const lines = captureLogs();
    const { queue } = await setup(async () => "fine");

    await queue.add("task", { n: 4 });
    await eventually(() => lines.some((line) => line.message === "Job task done"));

    expect(lines.filter((line) => line.message === "Job task done")).toEqual([
      { level: "log", message: "Job task done", attempt: 1 },
    ]);
  });

  it("numbers the tries of a job that fails once and then succeeds as 1 and 2", async () => {
    const lines = captureLogs();
    let calls = 0;
    const { queue } = await setup(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error("first try fails");
      }
      return "second time lucky";
    });

    await queue.add("task", { n: 5 });
    await eventually(() => lines.some((line) => line.message === "Job task done"));

    expect(lines.map((line) => [line.message, line.attempt])).toEqual([
      ["Job task failed, will try again", 1],
      ["Job task done", 2],
    ]);
  });
});
