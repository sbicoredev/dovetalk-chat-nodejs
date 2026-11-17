import { type BeforeApplicationShutdown, Inject, Injectable, Logger } from "@nestjs/common";
import type { Redis } from "ioredis";

import { type Database } from "@dovetalk/db";
import { currentTraceCarrier, SpanKind, withSpan } from "@dovetalk/telemetry";

import type { CoreOptions } from "../core.options.js";
import { CORE_OPTIONS, DRIZZLE, REDIS } from "../tokens.js";
import { findBotCandidates } from "./bot-candidates.js";
import { JobQueues } from "./job-queues.js";
import {
  BOT_REPLIES_QUEUE,
  BOT_REPLY_DELAY_MS,
  BOT_REPLY_JOB,
  BOT_TYPING_DELAY_MS,
  BOT_TYPING_JOB,
  type BotReplyJobData,
  botReplyJobId,
  botTypingJobId,
} from "./names.js";

/** A reply that never finishes cannot hold its chat for ever: the hold lapses by itself. */
export const PENDING_HOLD_MS = 30_000;

/** Deletes the hold only if it still belongs to this message, in one step. */
const RELEASE_IF_MINE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0`;

/**
 * Sets a bot's answer going when a person writes to a bot. Called by `MessagesService.send`
 * after the message is stored, in the API.
 *
 * It adds two delayed jobs, one that shows the bot typing and one that sends the reply, with
 * the mock's timings. The worker runs them (apps/worker). Nothing here can fail a send: the
 * work runs in the background and a problem is logged.
 *
 * At most one answer waits per chat, as in the mock: while one is pending, further messages in
 * that chat set nothing going. A short-lived key in Redis is the hold. The reply job lets it go
 * when it finishes, and it lapses on its own if the job never does.
 */
@Injectable()
export class BotReplyScheduler implements BeforeApplicationShutdown {
  private readonly logger = new Logger("BotReplies");
  private readonly running = new Set<Promise<void>>();

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(JobQueues) private readonly queues: JobQueues,
    @Inject(CORE_OPTIONS) private readonly options: CoreOptions,
  ) {}

  get enabled(): boolean {
    return this.options.jobs?.botReplies === true;
  }

  /** `senderId` just wrote message `messageId` in `chatId`. Returns at once. */
  messageSent(chatId: string, messageId: string, senderId: string): void {
    if (!this.enabled) {
      return;
    }
    const work: Promise<void> = this.schedule({ chatId, messageId, senderId })
      .catch((error: unknown) => {
        this.logger.error(
          { err: error, chatId, messageId },
          "Could not schedule a bot reply. The message was sent, the bot will not answer it.",
        );
      })
      .finally(() => this.running.delete(work));
    this.running.add(work);
  }

  /** Resolves when everything asked for so far has been scheduled. For tests and shutdown. */
  async idle(): Promise<void> {
    while (this.running.size > 0) {
      // biome-ignore lint/performance/noAwaitInLoops: more can be scheduled while these finish, so it waits again until there is none.
      await Promise.allSettled([...this.running]);
    }
  }

  beforeApplicationShutdown(): Promise<void> {
    return this.idle();
  }

  /** The Redis key that marks a chat as waiting for a bot's answer. */
  pendingKey(chatId: string): string {
    return `${this.queues.prefix}:bot-reply-pending:${chatId}`;
  }

  /** Lets go of the chat's hold if message `messageId` took it. */
  async release(chatId: string, messageId: string): Promise<void> {
    await this.redis.eval(RELEASE_IF_MINE, 1, this.pendingKey(chatId), messageId);
  }

  private async schedule(input: { chatId: string; messageId: string; senderId: string }) {
    const { chatId, messageId, senderId } = input;
    const bots = await findBotCandidates(this.db, chatId, senderId);
    if (bots.length === 0) {
      return;
    }

    const held = await this.redis.set(
      this.pendingKey(chatId),
      messageId,
      "PX",
      PENDING_HOLD_MS,
      "NX",
    );
    if (held !== "OK") {
      return;
    }

    const now = Date.now();
    try {
      await withSpan(
        "bot-replies publish",
        {
          kind: SpanKind.PRODUCER,
          attributes: {
            "messaging.system": "bullmq",
            "messaging.destination.name": BOT_REPLIES_QUEUE,
            "messaging.operation.type": "publish",
            "message.id": messageId,
          },
        },
        async () => {
          // Taken inside the span, so the worker's spans become children of this one.
          const data: BotReplyJobData = {
            chatId,
            messageId,
            senderId,
            replyAt: now + BOT_REPLY_DELAY_MS,
            trace: currentTraceCarrier(),
          };
          await this.queues.botReplies.addBulk([
            {
              name: BOT_TYPING_JOB,
              data,
              // Typing is a nicety: one more try is enough, and a late one is dropped by the worker.
              opts: { jobId: botTypingJobId(messageId), delay: BOT_TYPING_DELAY_MS, attempts: 2 },
            },
            {
              name: BOT_REPLY_JOB,
              data,
              opts: { jobId: botReplyJobId(messageId), delay: BOT_REPLY_DELAY_MS },
            },
          ]);
        },
      );
    } catch (error) {
      // Nothing was queued, so nothing will let the chat go. Do it here.
      await this.release(chatId, messageId).catch(() => undefined);
      throw error;
    }
  }
}
