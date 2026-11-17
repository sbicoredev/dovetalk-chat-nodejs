import { z } from "zod";

import { baseEnvSchema, parseEnv, storageEnvShape } from "@dovetalk/core";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const positiveInt = (fallback: number) => z.coerce.number().int().min(1).default(fallback);

export const workerEnvSchema = baseEnvSchema.extend({
  ...storageEnvShape,

  /** The worker has no public API. This tiny server only answers platform health probes. */
  WORKER_HEALTH_HOST: z.string().min(1).default("0.0.0.0"),
  WORKER_HEALTH_PORT: z.coerce.number().int().min(0).max(65_535).default(3002),

  // ---- Jobs -----------------------------------------------------------------------------

  /** Bot-reply jobs one process runs at once. Each is two quick queries and a write, mostly waiting. */
  BOT_REPLY_CONCURRENCY: z.coerce.number().int().min(1).max(500).default(25),

  /** How often each housekeeping job runs. Every worker replica registers the same schedule, once between them. */
  CLEANUP_GUESTS_EVERY_MS: positiveInt(10 * MINUTE),
  CLEANUP_STATUSES_EVERY_MS: positiveInt(10 * MINUTE),
  CLEANUP_ATTACHMENTS_EVERY_MS: positiveInt(HOUR),
  CLEANUP_TOKENS_EVERY_MS: positiveInt(HOUR),
  /** An upload nothing uses for this long is an orphan (the contract promises 24 hours). */
  ORPHAN_ATTACHMENT_AGE_MS: positiveInt(24 * HOUR),
  /** Rows one cleanup batch takes. A run repeats batches until none is full. */
  CLEANUP_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
});

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export const loadWorkerEnv = (env: Record<string, string | undefined> = process.env): WorkerEnv =>
  parseEnv(workerEnvSchema, env, "dovetalk-worker");

export const WORKER_ENV = Symbol("WORKER_ENV");
