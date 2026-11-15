/** Reactions offered in the message menu. */
export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

/** Emoji offered in the composer tray. */
export const EMOJI = ["😀", "😂", "😍", "🙏", "👍", "🎉", "🔥", "😅", "🥹", "❤️", "🌿", "☕"];

/** Backgrounds for status updates. `StatusDto.color` is an index into this list. */
export const STATUS_COLORS = [
  { bg: "#2E3190", fg: "#FFFFFF" },
  { bg: "#F4B63F", fg: "#121A33" },
  { bg: "#0F766E", fg: "#F0FDFA" },
  { bg: "#BE3A5B", fg: "#FFF1F4" },
  { bg: "#CFE3F7", fg: "#12304D" },
  { bg: "#121A33", fg: "#F4B63F" },
] as const;

// Shared with the backend so both sides agree on the numbers.
export { DEMO_EMAIL, DEMO_PASSWORD, MESSAGE_PAGE_SIZE, PIN_LIMIT } from "@dovetalk/contracts";
