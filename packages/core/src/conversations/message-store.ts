import { Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";

import type { MessageKind } from "@dovetalk/contracts";
import { type MessageRow, type SystemEvent, schema, type Transaction } from "@dovetalk/db";

import { DomainError } from "../errors.js";
import { must } from "../invariant.js";

const { chats, messages } = schema;

export interface AppendMessage {
  /** The file of an image or file message. */
  attachmentId?: string | null;
  bars?: number[] | null;
  chatId: string;
  clientId?: string | null;
  /** Leave out to use the database clock. Seed data sets it to put messages in the past. */
  createdAt?: Date;
  duration?: number | null;
  /** Set for, and only for, a system message. */
  event?: SystemEvent | null;
  forwarded?: boolean;
  kind: MessageKind;
  replyToId?: string | null;
  /** `null` for a system message. */
  senderId: string | null;
  text?: string | null;
}

/**
 * The one way a message gets into a chat. It takes the next place in the chat's order
 * (`chats.last_seq + 1`) and writes the row in the same transaction, so two messages sent at
 * once cannot get the same place and a chat never has a gap. Sending, forwarding and the seed all go through it.
 */
@Injectable()
export class MessageStore {
  /** Must run inside a transaction: the sequence bump and the insert stand or fall together. */
  async append(tx: Transaction, input: AppendMessage): Promise<MessageRow> {
    // The database ties a system message to "no sender, has an event" but says nothing about its
    // text. The meaning lives in the event, which each reader sees in their own words, so a
    // system message with text would be a second, viewer-blind version of it. Refuse it here.
    if (input.kind === "system" && input.text) {
      throw new Error("A system message carries an event, never text.");
    }
    // The UPDATE takes a row lock on the chat, which is what orders concurrent senders.
    const [bumped] = await tx
      .update(chats)
      .set({ lastSeq: sql`${chats.lastSeq} + 1` })
      .where(eq(chats.id, input.chatId))
      .returning({ seq: chats.lastSeq });
    if (!bumped) {
      throw new DomainError("CHAT_NOT_FOUND", "This chat no longer exists.");
    }

    const [row] = await tx
      .insert(messages)
      .values({
        chatId: input.chatId,
        seq: bumped.seq,
        senderId: input.senderId,
        kind: input.kind,
        text: input.text ?? null,
        duration: input.duration ?? null,
        bars: input.bars ?? null,
        attachmentId: input.attachmentId ?? null,
        replyToId: input.replyToId ?? null,
        clientId: input.clientId ?? null,
        forwarded: input.forwarded ?? false,
        event: input.event ?? null,
        // Never earlier than the message before it, so a clock that steps back (or two servers
        // that disagree) cannot put a message above an older one in a list sorted by time.
        createdAt:
          input.createdAt ??
          sql`greatest(clock_timestamp(), coalesce((select created_at from messages where chat_id = ${input.chatId} and seq = ${bumped.seq - 1}), '-infinity'::timestamptz))`,
      })
      .returning();
    return must(row, "the inserted message");
  }
}
