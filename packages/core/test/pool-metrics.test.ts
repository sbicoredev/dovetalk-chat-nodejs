import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestTelemetry, type TestTelemetry } from "@dovetalk/telemetry/testing";

import { PoolMetrics } from "../src/pool-metrics.js";

let telemetry: TestTelemetry;
beforeAll(() => {
  telemetry = startTestTelemetry("dovetalk-core-test");
});
afterAll(() => telemetry.shutdown());

/** A pool that counts how often its numbers are read. */
function countingPool(max: number) {
  const reads = { total: 0 };
  const pool = {
    get totalCount() {
      reads.total += 1;
      return 3;
    },
    idleCount: 2,
    waitingCount: 1,
    options: { max },
  } as unknown as Pool;
  return { pool, reads };
}

async function pointsOf(name: string) {
  const batches = await telemetry.collectMetrics();
  const last = batches.at(-1);
  const metric = last?.scopeMetrics
    .flatMap((s) => s.metrics)
    .find((m) => m.descriptor.name === name);
  return metric?.dataPoints ?? [];
}

describe("PoolMetrics", () => {
  it("reports the pool's connections by state and its limit", async () => {
    const { pool } = countingPool(7);
    const metrics = new PoolMetrics(pool);
    metrics.onModuleInit();
    try {
      const byState = Object.fromEntries(
        (await pointsOf("db_pool_connections")).map((p) => [p.attributes.state, p.value]),
      );
      expect(byState).toEqual({ total: 3, idle: 2, waiting: 1 });
      expect((await pointsOf("db_pool_max")).map((p) => p.value)).toEqual([7]);
    } finally {
      metrics.onModuleDestroy();
    }
  });

  it("lets go of the pool when the app stops, so a closed pool is never read again", async () => {
    const { pool, reads } = countingPool(5);
    const metrics = new PoolMetrics(pool);
    metrics.onModuleInit();

    await telemetry.collectMetrics();
    expect(reads.total).toBeGreaterThan(0);

    metrics.onModuleDestroy();
    const before = reads.total;
    await telemetry.collectMetrics();
    await telemetry.collectMetrics();
    expect(reads.total).toBe(before);
  });

  it("can be destroyed twice", () => {
    const metrics = new PoolMetrics(countingPool(5).pool);
    metrics.onModuleInit();
    metrics.onModuleDestroy();
    expect(() => metrics.onModuleDestroy()).not.toThrow();
  });
});
