import { Redis } from "ioredis";

export interface RedisOptions {
  /** Shown in CLIENT LIST so connections can be traced to a service. */
  name?: string;
  onError?: (error: Error) => void;
  url: string;
}

/**
 * One Redis connection. Commands fail after three retries instead of queueing forever, so a
 * Redis outage surfaces as errors rather than hung requests.
 */
export function createRedis(options: RedisOptions): Redis {
  const client = new Redis(options.url, {
    connectionName: options.name,
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
  });
  // An unhandled "error" event is noisy, and the client reconnects on its own.
  client.on("error", (error) => options.onError?.(error));
  return client;
}
