import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import type pg from "pg";

import { PG_POOL, REDIS } from "./tokens.js";

export type CheckResult = { ok: true; latencyMs: number } | { ok: false; error: string };

const DEFAULT_TIMEOUT_MS = 2000;

/** Runs a check but never waits longer than the timeout, so a hung dependency fails fast. */
async function timed(check: () => Promise<unknown>, timeoutMs: number): Promise<CheckResult> {
  const started = performance.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      check(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
    return { ok: true, latencyMs: Math.round(performance.now() - started) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Set once shutdown begins. Readiness reports it so traffic moves away before we stop. */
@Injectable()
export class ShutdownState {
  private begun = false;
  get draining() {
    return this.begun;
  }
  begin() {
    this.begun = true;
  }
}

@Injectable()
export class HealthChecks {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(REDIS) private readonly redis: Redis,
    readonly shutdown: ShutdownState,
  ) {}

  database(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CheckResult> {
    return timed(() => this.pool.query("SELECT 1"), timeoutMs);
  }

  cache(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CheckResult> {
    return timed(() => this.redis.ping(), timeoutMs);
  }

  /** Everything a request needs. Fails while the process is draining. */
  async ready(timeoutMs = DEFAULT_TIMEOUT_MS) {
    const [database, cache] = await Promise.all([this.database(timeoutMs), this.cache(timeoutMs)]);
    const ok = database.ok && cache.ok && !this.shutdown.draining;
    return { ok, draining: this.shutdown.draining, checks: { database, cache } };
  }
}
