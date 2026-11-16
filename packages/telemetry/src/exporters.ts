type Env = Record<string, string | undefined>;

/** The queue and timing settings of a batch processor, as the standard OTEL_BSP_* / OTEL_BLRP_* variables set them. */
export interface BatchOptions {
  exportTimeoutMillis?: number;
  maxExportBatchSize?: number;
  maxQueueSize?: number;
  scheduledDelayMillis?: number;
}

function positiveInteger(value: string | undefined): number | undefined {
  const number = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isInteger(number) && number > 0
    ? number
    : undefined;
}

/**
 * Reads the standard batch processor variables. `OTEL_BSP_*` are for spans and `OTEL_BLRP_*` for
 * logs: SCHEDULE_DELAY, EXPORT_TIMEOUT, MAX_QUEUE_SIZE and MAX_EXPORT_BATCH_SIZE (a number of
 * milliseconds or items). The SDK reads them only when it builds the processors itself, and
 * `startTelemetry` builds them, so without this they would be silently ignored. A value that is
 * missing or not a positive whole number leaves the SDK's default.
 */
export function batchOptionsFromEnv(env: Env, prefix: "OTEL_BSP" | "OTEL_BLRP"): BatchOptions {
  const options: BatchOptions = {};
  const scheduledDelayMillis = positiveInteger(env[`${prefix}_SCHEDULE_DELAY`]);
  const exportTimeoutMillis = positiveInteger(env[`${prefix}_EXPORT_TIMEOUT`]);
  const maxQueueSize = positiveInteger(env[`${prefix}_MAX_QUEUE_SIZE`]);
  const maxExportBatchSize = positiveInteger(env[`${prefix}_MAX_EXPORT_BATCH_SIZE`]);
  if (scheduledDelayMillis) {
    options.scheduledDelayMillis = scheduledDelayMillis;
  }
  if (exportTimeoutMillis) {
    options.exportTimeoutMillis = exportTimeoutMillis;
  }
  if (maxQueueSize) {
    options.maxQueueSize = maxQueueSize;
  }
  if (maxExportBatchSize) {
    options.maxExportBatchSize = maxExportBatchSize;
  }
  return options;
}

/** How long exports are skipped after one fails, when `TELEMETRY_EXPORT_COOLDOWN_MS` is not set. */
export const DEFAULT_EXPORT_COOLDOWN_MS = 30_000;

/** `TELEMETRY_EXPORT_COOLDOWN_MS`: milliseconds, `0` turns the guard off. */
export function exportCooldownFromEnv(env: Env): number {
  const raw = env.TELEMETRY_EXPORT_COOLDOWN_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_EXPORT_COOLDOWN_MS;
  }
  const number = Number(raw);
  return Number.isFinite(number) && number >= 0 ? number : DEFAULT_EXPORT_COOLDOWN_MS;
}

// The values of OTel's ExportResultCode. Spelled out so this package does not need to depend on
// @opentelemetry/core for two numbers.
const EXPORT_FAILED = 1;
// One instance: a stack trace per skipped batch would cost more than the batch.
const EXPORT_SKIPPED = new Error("Export skipped: the last one failed");

interface ExportResultLike {
  code: number;
  error?: Error;
}

type ExportFunction = (items: unknown, done: (result: ExportResultLike) => void) => void;

/**
 * Wraps an exporter so that, once an export fails, the next exports for `cooldownMs` fail at once
 * without trying. Without it an exporter whose Collector is down keeps every batch it was handed
 * for the whole retry cycle (five attempts with backoff, about 13 seconds), so spans and log
 * records live long enough to be promoted to the old generation of the heap and the process grows
 * by hundreds of megabytes. A failing export drops its batch in the end anyway, this makes it drop
 * it early. When the cooldown is over the next batch is tried, and one that succeeds ends it.
 *
 * Everything but `export` is passed through, so it works for span, log and metric exporters.
 */
export function guardExporter<T extends object>(
  exporter: T,
  cooldownMs: number,
  now: () => number = Date.now,
): T {
  if (cooldownMs <= 0) {
    return exporter;
  }
  let skipUntil = 0;
  const guarded: ExportFunction = (items, done) => {
    if (now() < skipUntil) {
      done({ code: EXPORT_FAILED, error: EXPORT_SKIPPED });
      return;
    }
    (exporter as { export: ExportFunction }).export(items, (result) => {
      if (result.code === EXPORT_FAILED) {
        skipUntil = now() + cooldownMs;
      }
      done(result);
    });
  };
  return new Proxy(exporter, {
    get(target, property) {
      if (property === "export") {
        return guarded;
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
