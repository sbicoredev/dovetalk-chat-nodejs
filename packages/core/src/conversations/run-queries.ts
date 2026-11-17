import type { Executor, Transaction } from "@dovetalk/db";

/** A transaction owns one connection, a pool does not. Only a transaction can `rollback`. */
const isTransaction = (executor: Executor): executor is Transaction => "rollback" in executor;

type Query<T> = () => PromiseLike<T>;
type Results<T extends readonly Query<unknown>[]> = { [K in keyof T]: Awaited<ReturnType<T[K]>> };

/**
 * Runs queries that do not depend on each other. On the pool they run at the same time, each on
 * its own connection. Inside a transaction there is one connection, and sending a second query
 * down it while the first is still running is deprecated in pg 8 and gone in pg 9, so they run
 * one after another there.
 *
 * Each query is passed as a function, because an `async` function starts running the moment it is
 * called, which would put it in flight before its turn.
 */
export async function runQueries<const T extends readonly Query<unknown>[]>(
  executor: Executor,
  queries: T,
): Promise<Results<T>> {
  if (!isTransaction(executor)) {
    return (await Promise.all(queries.map((query) => query()))) as Results<T>;
  }
  const results: unknown[] = [];
  for (const query of queries) {
    // biome-ignore lint/performance/noAwaitInLoops: one transaction connection runs one query at a time.
    results.push(await query());
  }
  return results as Results<T>;
}
