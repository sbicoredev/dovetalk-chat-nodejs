import type { ShutdownState } from "./health.js";

export interface ShutdownLogger {
  error: (message: string) => void;
  log: (message: string) => void;
}

export interface ShutdownOptions {
  /**
   * Runs after the app has closed and before the process exits, for work that must outlive the
   * app, such as sending the telemetry still in memory. It never delays the exit past `timeoutMs`
   * and a failure in it is ignored.
   */
  afterClose?: () => Promise<void>;
  app: { close: () => Promise<void> };
  /** Keep serving, but fail readiness, for this long before closing. */
  drainMs: number;
  /** Replaced in tests. */
  exit?: (code: number) => void;
  logger: ShutdownLogger;
  signals?: NodeJS.Signals[];
  state: ShutdownState;
  /** Exit anyway if closing takes longer than this. */
  timeoutMs: number;
}

/**
 * Handles SIGTERM and SIGINT: flip readiness, wait for the load balancer to notice, close the
 * app, exit. A second signal, or running out of time, exits immediately.
 * Returns a function that removes the handlers.
 */
export function installGracefulShutdown(options: ShutdownOptions): {
  stop: () => void;
  run: () => Promise<void>;
} {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const signals = options.signals ?? ["SIGTERM", "SIGINT"];
  let started: Promise<void> | null = null;

  const run = (): Promise<void> => {
    started ??= (async () => {
      const forced = setTimeout(() => {
        options.logger.error(`Shutdown took longer than ${options.timeoutMs} ms. Forcing exit.`);
        exit(1);
      }, options.timeoutMs);
      forced.unref();

      try {
        options.state.begin();
        if (options.drainMs > 0) {
          options.logger.log(`Draining for ${options.drainMs} ms.`);
          await new Promise((resolve) => setTimeout(resolve, options.drainMs));
        }
        await options.app.close();
        options.logger.log("Shut down cleanly.");
        await options.afterClose?.().catch(() => undefined);
        clearTimeout(forced);
        exit(0);
      } catch (error) {
        options.logger.error(
          `Shutdown failed: ${error instanceof Error ? error.stack : String(error)}`,
        );
        exit(1);
      }
    })();
    return started;
  };

  const handler = (signal: NodeJS.Signals) => {
    if (started) {
      options.logger.error(`Received ${signal} again. Exiting now.`);
      exit(1);
      return;
    }
    options.logger.log(`Received ${signal}.`);
    void run();
  };
  for (const signal of signals) {
    process.on(signal, handler);
  }

  return {
    run,
    stop() {
      for (const signal of signals) {
        process.off(signal, handler);
      }
    },
  };
}
