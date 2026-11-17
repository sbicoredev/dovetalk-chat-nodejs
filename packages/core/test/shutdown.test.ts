import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installGracefulShutdown, ShutdownState } from "../src/index.js";

const logger = { log: vi.fn(), error: vi.fn() };

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("installGracefulShutdown", () => {
  it("fails readiness first, drains, then closes and exits 0", async () => {
    const state = new ShutdownState();
    const order: string[] = [];
    const exit = vi.fn((code: number) => void order.push(`exit:${code}`));
    const app = {
      close: async () => void order.push(`close(draining=${state.draining})`),
    };
    const shutdown = installGracefulShutdown({
      app,
      state,
      logger,
      drainMs: 5000,
      timeoutMs: 20_000,
      exit,
      signals: [],
    });

    const done = shutdown.run();
    expect(state.draining).toBe(true);
    expect(order).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    await done;
    expect(order).toEqual(["close(draining=true)", "exit:0"]);
  });

  it("runs once however many times it is asked", async () => {
    const close = vi.fn(async () => undefined);
    const shutdown = installGracefulShutdown({
      app: { close },
      state: new ShutdownState(),
      logger,
      drainMs: 0,
      timeoutMs: 20_000,
      exit: () => undefined,
      signals: [],
    });
    await Promise.all([shutdown.run(), shutdown.run()]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("forces exit 1 when closing hangs", async () => {
    const exit = vi.fn();
    const shutdown = installGracefulShutdown({
      app: { close: () => new Promise<void>(() => undefined) },
      state: new ShutdownState(),
      logger,
      drainMs: 0,
      timeoutMs: 3000,
      exit,
      signals: [],
    });
    void shutdown.run();
    await vi.advanceTimersByTimeAsync(3000);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("exits 1 when closing throws", async () => {
    const exit = vi.fn();
    const shutdown = installGracefulShutdown({
      app: { close: async () => Promise.reject(new Error("nope")) },
      state: new ShutdownState(),
      logger,
      drainMs: 0,
      timeoutMs: 20_000,
      exit,
      signals: [],
    });
    await shutdown.run();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
