/** How many chats a person can pin. Enforced by the server. */
export const PIN_LIMIT = 3;

/** Messages per page when the client does not ask for a size. */
export const MESSAGE_PAGE_SIZE = 25;
/** The most messages one page can hold. */
export const MESSAGE_PAGE_MAX = 100;

/** Largest upload the server accepts, in bytes. The web app rejects bigger files up front. */
export const UPLOAD_LIMIT_BYTES = 10_000_000;

export const MAX_MESSAGE_TEXT = 4000;
/** The longest `clientId` the server accepts. The web app sends a UUID (36 characters). */
export const CLIENT_ID_MAX = 100;
/** Waveform bars in a voice message. The web app makes about 40. */
export const VOICE_BARS_MAX = 200;
/** A voice message of a day is already absurd. The cap only keeps the column sane. */
export const VOICE_DURATION_MAX_SECONDS = 86_400;
/** The longest emoji reaction, in UTF-16 units. A family emoji with skin tones is 25. */
export const REACTION_EMOJI_MAX = 32;
/** Chats one message can be forwarded to in a single call. */
export const FORWARD_CHATS_MAX = 20;
/** The longest file name kept for an upload, in characters. */
export const FILE_NAME_MAX = 255;
/** The largest width or height of an uploaded image, as reported by the client. */
export const IMAGE_EDGE_MAX = 20_000;
export const GROUP_NAME_MAX = 60;
/** Other people in one group, not counting its owner. */
export const GROUP_MEMBERS_MAX = 255;
export const CONTACT_NAME_MAX = 60;
export const CONTACT_ABOUT_MAX = 140;
export const STATUS_TEXT_MAX = 120;
/** `StatusDto.color` is an index into a palette of this many colors. */
export const STATUS_COLOR_COUNT = 6;
export const STATUS_TTL_MS = 24 * 60 * 60 * 1000;
export const MIN_PHONE_DIGITS = 7;
/** The longest number E.164 allows. */
export const MAX_PHONE_DIGITS = 15;

export const PROFILE_NAME_MAX = 60;
export const PROFILE_ABOUT_MAX = 140;
export const PASSWORD_MIN = 8;
/** Long enough for any passphrase, short enough that hashing one cannot be used to tie up the CPU. */
export const PASSWORD_MAX = 128;
export const EMAIL_MAX = 254;
/** The about text new accounts start with. Matches the mock server. */
export const DEFAULT_ABOUT = "Hey there, I am using Dovetalk.";
/** Guest accounts get a generated address on this reserved (RFC 6761) domain. They cannot sign in with it. */
export const GUEST_EMAIL_DOMAIN = "guest.dovetalk.invalid";
export const GUEST_TTL_MS = 24 * 60 * 60 * 1000;

/** Demo account created by the seed script. */
export const DEMO_EMAIL = "demo@dovetalk.app";
export const DEMO_PASSWORD = "dovetalk123";
