import { Logger } from "@nestjs/common";
import { type ConnectionOptions, type Job, Worker } from "bullmq";

import {
  captureContext,
  contextFromCarrier,
  dovetalkMetrics,
  runInContext,
  SpanKind,
  type TraceCarrier,
  withSpan,
} from "@dovetalk/telemetry";

export interface RunWorkerOptions<Data, Name extends string> {
  concurrency: number;
  connection: ConnectionOptions;
  /** Runs when a job has failed for the last time. Must not throw. */
  onDeadLetter?: (job: Job<Data, unknown, Name>, error: Error) => Promise<void>;
  prefix: string;
  process: (job: Job<Data, unknown, Name>) => Promise<unknown>;
  queue: string;
}

/**
 * A BullMQ `Worker` with the logging and failure handling every queue here wants:
 *
 * - one structured line per finished job, with the queue, job, attempt and how long it took;
 * - a failed job that will be tried again is a warning; one out of attempts is an error. It stays
 *   in BullMQ's failed set (kept for a week, see `BOT_JOB_DEFAULTS`), which is the dead-letter
 *   store, and `onDeadLetter` gets a chance to clean up after it;
 * - a job whose worker stopped renewing its lock (the process died or hung) is logged as stalled
 *   before BullMQ hands it to another worker;
 * - every run is a span (a child of the request that queued the job, when the job's data carries
 *   its trace context) and is counted and timed in `jobs_total` and `job_duration_ms`. The lines
 *   above are written under that span, so the trace links to them in the logs.
 */
export function runWorker<Data, Name extends string>(
  options: RunWorkerOptions<Data, Name>,
): Worker<Data, unknown, Name> {
  const logger = new Logger(`Jobs:${options.queue}`);

  // BullMQ reports "completed" and "failed" after the processor returned, when the span has ended
  // and nothing is active. The job's span context is kept here so those lines are still written
  // under it. A job's entry goes with the job object.
  const spanContexts = new WeakMap<Job<Data, unknown, Name>, ReturnType<typeof captureContext>>();
  const underJobTrace = (job: Job<Data, unknown, Name>, write: () => void) => {
    const captured = spanContexts.get(job);
    if (captured) {
      runInContext(captured, write);
    } else {
      write();
    }
  };

  const processTraced = (job: Job<Data, unknown, Name>) => {
    const trace = (job.data as { trace?: TraceCarrier } | null)?.trace;
    const startedAt = performance.now();
    const finish = (outcome: "ok" | "error") => {
      // Not `job`: Prometheus gives every series a `job` label of its own (the service name) and
      // the Collector's remote write lets it win, so every job would read as "dovetalk-worker".
      const labels = { queue: options.queue, job_name: job.name, outcome };
      dovetalkMetrics().jobs.add(1, labels);
      dovetalkMetrics().jobDuration.record(performance.now() - startedAt, labels);
    };
    return withSpan(
      `${options.queue} process`,
      {
        kind: SpanKind.CONSUMER,
        parent: contextFromCarrier(trace),
        attributes: {
          "messaging.system": "bullmq",
          "messaging.destination.name": options.queue,
          "messaging.operation.type": "process",
          "messaging.message.id": job.id ?? "",
          "job.name": job.name,
          "job.attempt": job.attemptsMade + 1,
        },
      },
      () => {
        spanContexts.set(job, captureContext());
        return options.process(job);
      },
    ).then(
      (result) => {
        finish("ok");
        return result;
      },
      (error: unknown) => {
        finish("error");
        throw error;
      },
    );
  };

  const worker = new Worker<Data, unknown, Name>(options.queue, processTraced, {
    connection: options.connection,
    prefix: options.prefix,
    concurrency: options.concurrency,
  });

  // The events below fire after the try ended, and by then `attemptsMade` already counts it,
  // whether it succeeded or failed. So it is the number of the try that just finished.
  const describe = (job: Job<Data, unknown, Name>) => ({
    queue: options.queue,
    job: job.name,
    jobId: job.id,
    attempt: job.attemptsMade,
    attempts: job.opts.attempts ?? 1,
  });

  worker.on("completed", (job, result) => {
    const durationMs =
      job.finishedOn && job.processedOn ? job.finishedOn - job.processedOn : undefined;
    underJobTrace(job, () =>
      logger.log({ ...describe(job), durationMs, result }, `Job ${job.name} done`),
    );
  });

  worker.on("failed", (job, error) => {
    if (!job) {
      logger.error({ queue: options.queue, err: error }, "A job failed and could not be read");
      return;
    }
    const info = { ...describe(job), err: error, data: job.data };
    const final = info.attempt >= info.attempts;
    if (!final) {
      underJobTrace(job, () => logger.warn(info, `Job ${job.name} failed, will try again`));
      return;
    }
    underJobTrace(job, () =>
      logger.error(info, `Job ${job.name} failed for good, kept in the failed set`),
    );
    options.onDeadLetter?.(job, error).catch((cleanupError: unknown) => {
      underJobTrace(job, () =>
        logger.error(
          { err: cleanupError, ...describe(job) },
          "Cleaning up after a failed job failed",
        ),
      );
    });
  });

  worker.on("stalled", (jobId) => {
    logger.warn(
      { queue: options.queue, jobId },
      "A job stalled and will be given to another worker",
    );
  });

  // An unhandled "error" event would crash the process. BullMQ reconnects on its own.
  worker.on("error", (error) => {
    logger.error({ queue: options.queue, err: error }, "The queue connection reported an error");
  });

  return worker;
}
