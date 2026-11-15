import type { Api, RealtimeClient } from "../api";

/**
 * The parts of the contract the suite checks. A target lists the ones it implements, and the
 * rest show up as skipped tests, so progress is visible in the output. A target lists the areas it implements. `bots` needs the
 * worker (it is what answers), so a run against the real API needs the worker running.
 */
export const CONFORMANCE_AREAS = [
  "auth",
  "profile",
  "contacts",
  "paging",
  "sending",
  "chats",
  "actions",
  "uploads",
  "statuses",
  "realtime",
  "bots",
] as const;

export type ConformanceArea = (typeof CONFORMANCE_AREAS)[number];

export interface LoginOptions {
  /** Contacts answer messages with typing and a reply. Only the bots area needs it. */
  botReplies?: boolean;
}

/** One signed-in person, on a fresh account. */
export interface ConformanceSession {
  api: Api;
  realtime: RealtimeClient;
}

export interface WaitOptions {
  /** What to report if the condition never became true. */
  message?: string;
  timeoutMs?: number;
}

/**
 * What a backend has to provide to be run through `runApiConformance`. There are two: the
 * in-browser mock and the real API over HTTP and socket.io.
 */
export interface ConformanceHarness {
  /** A client with no credentials. */
  anonymous: () => Api;
  areas: ReadonlySet<ConformanceArea> | "all";
  /** Closes whatever `login` opened. Runs once, after the last test. */
  cleanup: () => Promise<void>;
  /** Only for targets that run on timers. The realtime tests install it around each test. */
  clock?: { install: () => void; restore: () => void };
  /** The seeded demo account. */
  demo: { email: string; password: string };
  /** Waits until `check()` is true. Advances a fake clock, or polls in real time. */
  eventually: (check: () => boolean, options?: WaitOptions) => Promise<void>;
  /**
   * Starts a new session on a fresh account, so tests never see each other's changes. A new
   * account starts with the seeded contacts, chats and statuses.
   */
  login: (options?: LoginOptions) => Promise<ConformanceSession>;
  /** Prefixes every test name, so a failure says which backend it came from. */
  name: string;
  /** The largest upload the target accepts. The oversize test goes one byte past it. */
  uploadLimitBytes: number;
}
