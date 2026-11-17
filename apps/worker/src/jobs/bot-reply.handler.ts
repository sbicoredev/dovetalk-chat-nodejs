import { Inject, Injectable } from "@nestjs/common";

import {
  type BotReplyJobData,
  BotReplyScheduler,
  botFor,
  botReplyClientId,
  DomainError,
  DRIZZLE,
  findBotCandidates,
  MessagesService,
  RealtimeEvents,
  replyTextFor,
} from "@dovetalk/core";
import type { Database } from "@dovetalk/db";

/** What a bot-reply job did, for the log. */
export type BotReplyOutcome =
  | "typing"
  /** The reply was due already, so showing "typing" would only flash. */
  | "late"
  /** Nobody to answer any more: the sender left or deleted the chat, or blocked the bot. */
  | "nobody"
  | "sent"
  /** The reply was already there: this is a retry of a job that had got as far as writing it. */
  | "already-sent";

/**
 * The two halves of a bot's answer. Both are safe to run twice:
 *
 * - They choose the bot and the line from the message id alone, so a retry says the same thing.
 * - The reply is sent under a `clientId` made from the message id, so `MessagesService.send`
 *   treats a second attempt as the replay of the first and adds nothing, not even an unread.
 * - Showing and clearing "typing" are idempotent by nature.
 *
 * The reply goes through `MessagesService.send`, the same code a person's message goes through,
 * so it takes its place in the chat, counts as unread for the person, and is announced to their
 * sockets on whichever API instance holds them (docs/adr/0001).
 */
@Injectable()
export class BotReplyHandler {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(RealtimeEvents) private readonly events: RealtimeEvents,
    @Inject(BotReplyScheduler) private readonly scheduler: BotReplyScheduler,
  ) {}

  /** The bot starts "typing", unless its answer is due already. */
  async typing(data: BotReplyJobData): Promise<BotReplyOutcome> {
    if (Date.now() >= data.replyAt) {
      return "late";
    }
    const bots = await findBotCandidates(this.db, data.chatId, data.senderId);
    if (bots.length === 0) {
      return "nobody";
    }
    const bot = botFor(bots, data.messageId);
    this.events.typing(data.chatId, bot.id, true);
    return "typing";
  }

  /** The bot stops "typing" and answers. */
  async reply(data: BotReplyJobData): Promise<BotReplyOutcome> {
    const { chatId, messageId, senderId } = data;
    const bots = await findBotCandidates(this.db, chatId, senderId);
    if (bots.length === 0) {
      await this.scheduler.release(chatId, messageId);
      return "nobody";
    }
    const bot = botFor(bots, messageId);

    // The mock says "stopped typing" first, then the message.
    this.events.typing(chatId, bot.id, false);
    try {
      const { created } = await this.messages.send(bot.id, chatId, {
        kind: "text",
        text: replyTextFor(messageId),
        clientId: botReplyClientId(messageId),
      });
      await this.scheduler.release(chatId, messageId);
      return created ? "sent" : "already-sent";
    } catch (error) {
      // The chat went away between the check and the send. Retrying cannot bring it back.
      if (error instanceof DomainError && error.code === "CHAT_NOT_FOUND") {
        await this.scheduler.release(chatId, messageId);
        return "nobody";
      }
      throw error;
    }
  }

  /** A reply that is out of attempts will never run again, so the chat must not wait for it. */
  async giveUp(data: BotReplyJobData): Promise<void> {
    const bots = await findBotCandidates(this.db, data.chatId, data.senderId);
    if (bots.length > 0) {
      this.events.typing(data.chatId, botFor(bots, data.messageId).id, false);
    }
    await this.scheduler.release(data.chatId, data.messageId);
  }
}
