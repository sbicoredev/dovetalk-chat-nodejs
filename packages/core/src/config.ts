import { z } from "zod";

/** Environment variables both the API and the worker read. */
export const baseEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  APP_VERSION: z.string().min(1).default("dev"),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Human-readable logs for local work. Leave off in production. */
  LOG_PRETTY: z.stringbool().default(false),

  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/u }),
  /** Connections per process. Total = this × the number of API and worker instances. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(0).default(15_000),

  REDIS_URL: z.url({ protocol: /^rediss?$/u }),
  /**
   * Starts the name of every job queue key in Redis. The API and the worker must use the same
   * one, and two deployments sharing a Redis must use different ones.
   */
  QUEUE_PREFIX: z
    .string()
    .regex(/^[\w-]{1,40}$/u, "must be 1 to 40 letters, digits, underscores or dashes")
    .default("dovetalk"),

  /** After SIGTERM, keep serving but fail readiness for this long so the load balancer drains us. */
  SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).default(0),
  /** Hard limit for the whole shutdown. After this the process exits anyway. */
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(15_000),
});

export type BaseEnv = z.infer<typeof baseEnvSchema>;

export class ConfigError extends Error {
  constructor(
    readonly service: string,
    readonly problems: string[],
  ) {
    super(`Invalid configuration for ${service}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

/** Parses the environment against a schema and reports every problem at once. */
export function parseEnv<S extends z.ZodType>(
  schema: S,
  env: Record<string, string | undefined>,
  service: string,
): z.infer<S> {
  // Empty strings usually mean "unset" in .env files, so treat them that way.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
  const result = schema.safeParse(cleaned);
  if (!result.success) {
    throw new ConfigError(
      service,
      result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  return result.data;
}
