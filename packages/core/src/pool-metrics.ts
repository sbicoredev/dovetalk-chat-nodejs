import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { Pool } from "pg";

import { observeGauge } from "@dovetalk/telemetry";

import { PG_POOL } from "./tokens.js";

/**
 * Reports how busy this process's Postgres pool is, read when metrics are collected. A pool that
 * is always full with a growing queue is the first sign that `DATABASE_POOL_MAX` is too low.
 *
 * - `db_pool_connections{state="total|idle|waiting"}`: open, idle, and requests waiting for one.
 * - `db_pool_max`: the limit, so a dashboard can draw usage as a share of it.
 *
 * The gauges hold this pool, so they are removed when the app stops. Left behind, a stopped app's
 * closed pool would keep reporting zeros next to the live one's numbers (tests start many apps in
 * one process).
 */
@Injectable()
export class PoolMetrics implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("PoolMetrics");
  private readonly stops: (() => void)[] = [];

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  onModuleInit(): void {
    const onError = (error: unknown) =>
      this.logger.warn(
        `Could not read the pool: ${error instanceof Error ? error.message : String(error)}`,
      );
    this.stops.push(
      observeGauge(
        "db_pool_connections",
        "Postgres connections held by this process, by state.",
        () => [
          { value: this.pool.totalCount, attributes: { state: "total" } },
          { value: this.pool.idleCount, attributes: { state: "idle" } },
          { value: this.pool.waitingCount, attributes: { state: "waiting" } },
        ],
        onError,
      ),
      observeGauge(
        "db_pool_max",
        "The most Postgres connections this process may open.",
        // pg always fills in `max` (10 unless the pool is configured), so there is no default here.
        () => [{ value: this.pool.options.max }],
        onError,
      ),
    );
  }

  onModuleDestroy(): void {
    for (const stop of this.stops.splice(0)) {
      stop();
    }
  }
}
