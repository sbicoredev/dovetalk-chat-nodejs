import { describe, expect, it } from "vitest";

import type { Executor } from "@dovetalk/db";

import { runQueries } from "../src/conversations/run-queries.js";

/** A query that records how many are running when it starts, and answers after a tick. */
function probe() {
  let running = 0;
  let mostAtOnce = 0;
  const query =
    <T>(value: T) =>
    async () => {
      running += 1;
      mostAtOnce = Math.max(mostAtOnce, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return value;
    };
  return { query, mostAtOnce: () => mostAtOnce };
}

// What matters here is only that the transaction has `rollback` and the pool has not.
const pool = {} as Executor;
const transaction = { rollback: () => undefined } as unknown as Executor;

describe("runQueries", () => {
  it("runs queries at the same time on the pool, and keeps the order of the answers", async () => {
    const { query, mostAtOnce } = probe();
    const [a, b, c] = await runQueries(pool, [query("a"), query(2), query(true)]);
    expect([a, b, c]).toEqual(["a", 2, true]);
    expect(mostAtOnce()).toBe(3);
  });

  it("runs them one after another inside a transaction, which has one connection", async () => {
    const { query, mostAtOnce } = probe();
    const [a, b, c] = await runQueries(transaction, [query("a"), query(2), query(true)]);
    expect([a, b, c]).toEqual(["a", 2, true]);
    expect(mostAtOnce()).toBe(1);
  });

  it("does not start a query before its turn, even an async one", async () => {
    const started: string[] = [];
    await runQueries(transaction, [
      async () => {
        started.push("first");
        await new Promise((resolve) => setTimeout(resolve, 5));
        started.push("first done");
      },
      () => {
        started.push("second");
        return Promise.resolve();
      },
    ]);
    expect(started).toEqual(["first", "first done", "second"]);
  });

  it("stops at the first failure and starts nothing after it", async () => {
    const started: string[] = [];
    await expect(
      runQueries(transaction, [
        () => Promise.reject(new Error("boom")),
        () => {
          started.push("second");
          return Promise.resolve();
        },
      ]),
    ).rejects.toThrow("boom");
    expect(started).toEqual([]);
  });
});
