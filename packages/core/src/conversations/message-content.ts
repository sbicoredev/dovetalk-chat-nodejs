import {
  CLIENT_ID_MAX,
  MAX_MESSAGE_TEXT,
  REACTION_EMOJI_MAX,
  type SendMessageInput,
  VOICE_BARS_MAX,
  VOICE_DURATION_MAX_SECONDS,
} from "@dovetalk/contracts";

import { DomainError } from "../errors.js";

const invalid = (...messages: string[]) => new DomainError("VALIDATION_ERROR", messages);

/** A message's or caption's text, trimmed. Too long is an error here, a cut elsewhere. */
export function requireText(raw: unknown, label = "Message"): string {
  const value = typeof raw === "string" ? raw.trim() : "";
  if (!value) {
    throw invalid(`${label} can't be empty.`);
  }
  if (value.length > MAX_MESSAGE_TEXT) {
    throw invalid(`${label} is too long. The limit is ${MAX_MESSAGE_TEXT} characters.`);
  }
  return value;
}

/** A caption: trimmed and cut at the limit. Empty is no caption, never an error. */
export const caption = (raw: unknown): string | null =>
  (typeof raw === "string" ? raw.trim().slice(0, MAX_MESSAGE_TEXT) : "") || null;

export function requireClientId(raw: unknown): string {
  if (typeof raw !== "string" || raw.length < 1 || raw.length > CLIENT_ID_MAX) {
    throw invalid(`clientId must be 1 to ${CLIENT_ID_MAX} characters.`);
  }
  return raw;
}

/** What a send puts in the row, once the kind's rules have been applied. */
export interface MessageContent {
  bars: number[] | null;
  duration: number | null;
  /** `true` for `image` and `file`: they need an attachment. */
  needsAttachment: boolean;
  text: string | null;
}

const isBar = (bar: unknown): bar is number =>
  typeof bar === "number" && Number.isFinite(bar) && bar >= 0 && bar <= 100;

/**
 * Applies the rules of each kind (see the mock's `send`). A text message has text and nothing
 * else. A voice message has a length and no text. A picture or file needs its attachment and may
 * carry a caption. Whatever does not belong to the kind is dropped, not rejected, as the mock does.
 */
export function checkContent(input: SendMessageInput): MessageContent {
  switch (input.kind) {
    case "text":
      return { text: requireText(input.text), duration: null, bars: null, needsAttachment: false };
    case "voice": {
      const { duration, bars } = input;
      if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 1) {
        throw invalid("A voice message needs a length.");
      }
      const seconds = Math.round(duration);
      if (seconds > VOICE_DURATION_MAX_SECONDS) {
        throw invalid("That voice message is too long.");
      }
      if (
        bars !== undefined &&
        bars !== null &&
        !(Array.isArray(bars) && bars.length <= VOICE_BARS_MAX && bars.every(isBar))
      ) {
        throw invalid(`Waveform bars must be up to ${VOICE_BARS_MAX} numbers from 0 to 100.`);
      }
      return { text: null, duration: seconds, bars: bars ?? null, needsAttachment: false };
    }
    case "image":
    case "file":
      return { text: caption(input.text), duration: null, bars: null, needsAttachment: true };
    default:
      throw invalid("Unknown message kind.");
  }
}

/**
 * Emoji, joiners, skin tones, flags and keycaps (a bare digit is not a reaction, the keycap
 * sequence 1️⃣ is). Anything else, letters and spaces included, is not.
 */
const EMOJI_ONLY =
  /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}]|[\u{E0020}-\u{E007F}]|[‍️⃣]|[0-9#*])+$/u;
const EMOJI_CORE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

export function requireEmoji(raw: unknown): string {
  if (
    typeof raw !== "string" ||
    raw.length < 1 ||
    raw.length > REACTION_EMOJI_MAX ||
    !EMOJI_ONLY.test(raw) ||
    !EMOJI_CORE.test(raw)
  ) {
    throw invalid("That isn't an emoji.");
  }
  return raw;
}
