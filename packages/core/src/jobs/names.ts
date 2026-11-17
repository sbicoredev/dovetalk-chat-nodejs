/**
 * The names and payloads of the jobs, shared by the code that adds them (the API, through core)
 * and the code that runs them (the worker). Keeping both ends in one file is what stops them
 * drifting apart.
 */

/** What a person's message to a bot sets going. See `BotReplyScheduler`. */
export const BOT_REPLIES_QUEUE = "bot-replies";
/** Repeating housekeeping: expired guests and statuses, orphan files, old refresh tokens. */
export const MAINTENANCE_QUEUE = "maintenance";

export const BOT_TYPING_JOB = "typing";
export const BOT_REPLY_JOB = "reply";

/** The mock's timings: the bot starts typing after this, and its reply lands after this. */
export const BOT_TYPING_DELAY_MS = 700;
export const BOT_REPLY_DELAY_MS = 2400;

/** One person's message that a bot will answer, and when the answer is due. */
export interface BotReplyJobData {
  chatId: string;
  /** The message being answered. The reply's idempotency key is made from it. */
  messageId: string;
  /** Epoch milliseconds the reply is due. A typing job that runs after this does nothing. */
  replyAt: number;
  /** The person who wrote it. */
  senderId: string;
  /**
   * The W3C trace context of the request that caused the jobs, so the worker's spans continue
   * that trace. Absent when nothing was being traced. Old jobs without it still run.
   */
  trace?: Record<string, string>;
}

/**
 * BullMQ turns a job id into part of a Redis key and refuses a plain integer, so these are
 * prefixed. A message that is sent once gets exactly one typing job and one reply job, however
 * many times the code that adds them runs.
 */
export const botTypingJobId = (messageId: string) => `bot-typing-${messageId}`;
export const botReplyJobId = (messageId: string) => `bot-reply-${messageId}`;

/** The key a bot's reply is sent under. A retried job sends the same one, so it posts once. */
export const botReplyClientId = (messageId: string) => `bot-reply:${messageId}`;

export const MAINTENANCE_TASKS = [
  "expire-guests",
  "expire-statuses",
  "sweep-orphan-attachments",
  "sweep-refresh-tokens",
] as const;
export type MaintenanceTask = (typeof MAINTENANCE_TASKS)[number];
