// Kept apart from the service so that `core.options.ts` can name these types without the two
// files importing each other.

/** How long a connection counts as alive without a heartbeat, and how long "offline" waits. */
export interface PresenceOptions {
  /** After the last connection closes, wait this long before saying offline, so a reload does not flap. */
  offlineDebounceMs: number;
  /** A connection that has not been refreshed for this long is treated as gone (its instance crashed). */
  socketTtlMs: number;
}

export const DEFAULT_PRESENCE: PresenceOptions = {
  socketTtlMs: 45_000,
  offlineDebounceMs: 5000,
};
