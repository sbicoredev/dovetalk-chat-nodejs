const KEY = Symbol.for("dovetalk.telemetry.shutdown");

interface Registry {
  [KEY]?: () => Promise<void>;
}

/** Called by `startTelemetry`, so the app can flush what is still buffered when it stops. */
export function registerTelemetryShutdown(shutdown: () => Promise<void>): void {
  (globalThis as Registry)[KEY] = shutdown;
}

/**
 * Sends the spans, metrics and logs still waiting in memory. Call it after the app has closed and
 * before the process exits, so the last requests are not lost. Safe when telemetry is off, when it
 * was already shut down, and when the exporter is unreachable (it gives up after `timeoutMs`).
 */
export async function shutdownTelemetry(timeoutMs = 5000): Promise<void> {
  const registry = globalThis as Registry;
  const shutdown = registry[KEY];
  registry[KEY] = undefined;
  if (!shutdown) {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      shutdown(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // Losing the last batch must not turn a clean stop into a failed one.
  } finally {
    clearTimeout(timer);
  }
}
