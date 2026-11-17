import { MAX_PHONE_DIGITS, MIN_PHONE_DIGITS } from "@dovetalk/contracts";

/** What people type: digits, a leading +, and the usual separators. */
const ALLOWED = /^\+?[\d\s().-]+$/u;

export interface ParsedPhone {
  digits: string;
  display: string;
}

/**
 * Checks a phone number as typed. We do not know the person's country, so there is no full
 * international parsing: the number needs 7 to 15 digits and nothing but the usual separators.
 * `display` is kept for showing back to them. The database derives the digits it compares.
 */
export function parsePhone(raw: string): ParsedPhone | null {
  const display = raw.trim();
  if (!ALLOWED.test(display) || display.indexOf("+") > 0) {
    return null;
  }
  const digits = display.replace(/\D/gu, "");
  if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) {
    return null;
  }
  return { display, digits };
}

export const PHONE_MESSAGE = `Enter a phone number with ${MIN_PHONE_DIGITS} to ${MAX_PHONE_DIGITS} digits.`;
