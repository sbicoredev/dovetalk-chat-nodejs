import type { DatabaseOptions } from "@dovetalk/db";

import type { PresenceOptions } from "./realtime/presence.options.js";
import type { StorageOptions } from "./storage/storage.config.js";

export interface JobsOptions {
  /**
   * Whether a person's message to a bot adds the jobs that make the bot answer. On in the API,
   * which sees the messages. Off in the worker, whose own replies must not set more going.
   */
  botReplies?: boolean;
  /** Names the Redis keys of the queues. Give every test its own so suites never share a queue. */
  prefix?: string;
}

/**
 * What `CoreModule.forRoot` takes. Kept apart from the module so the services that read these
 * options (the storage service) do not have to import the module that provides them.
 */
export interface CoreOptions {
  database: Omit<DatabaseOptions, "onPoolError" | "applicationName">;
  /** Background jobs. Leave out to add none, which is what a process that only reads wants. */
  jobs?: JobsOptions;
  /** How long a connection stays alive without a heartbeat, and the offline debounce. Defaults suit production. */
  presence?: Partial<PresenceOptions>;
  redisUrl: string;
  /** Names the service in Postgres and Redis connection lists, for example "dovetalk-api". */
  serviceName: string;
  /** Object storage for uploads. See `storageOptionsFromEnv`. */
  storage: StorageOptions;
}
