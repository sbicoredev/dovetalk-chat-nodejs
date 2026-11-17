import { createHash } from "node:crypto";

/**
 * What the bots say back. The same lines as the prototype's mock (`replies.ts`), so the real
 * backend and the in-browser one sound alike.
 */
export const CANNED_REPLIES = [
  "Sounds good to me.",
  "Give me a few minutes and I will get back to you.",
  "Ha, that made my day.",
  "Can we talk about it later tonight?",
  "Got it, thanks for letting me know.",
  "I was just about to message you.",
  "Perfect, see you then.",
  "Let me check and confirm.",
] as const;

/**
 * A number in `[0, size)` that depends only on `seed` and `salt`. The mock picks at random; a
 * job that can run twice must pick the same bot and the same line both times, or a retry would
 * post a second, different reply under the same `clientId`'s sender. Hashing the message id
 * keeps the variety (every message gets its own pick) and drops the randomness.
 */
export function pick(seed: string, salt: string, size: number): number {
  if (size < 1) {
    throw new RangeError("Nothing to pick from.");
  }
  const digest = createHash("sha256").update(`${salt}:${seed}`).digest();
  return digest.readUInt32BE(0) % size;
}

/** The line a bot answers `messageId` with. */
export const replyTextFor = (messageId: string): string =>
  CANNED_REPLIES[pick(messageId, "text", CANNED_REPLIES.length)] as string;

/** The bot that answers `messageId`. `candidates` must come in a stable order (by id). */
export function botFor<T>(candidates: readonly T[], messageId: string): T {
  return candidates[pick(messageId, "bot", candidates.length)] as T;
}
