import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Redis } from "ioredis";

import type { CoreOptions } from "../core.options.js";
import { CORE_OPTIONS, REDIS } from "../tokens.js";
import { DEFAULT_PRESENCE, type PresenceOptions } from "./presence.options.js";

export { DEFAULT_PRESENCE, type PresenceOptions } from "./presence.options.js";

const SOCKETS_KEY = "presence:sockets:";
const DUE_KEY = "presence:due";

/**
 * Adds or refreshes a connection. KEYS: the person's connections, the due set.
 * ARGV: now, expiry, socket id, user id, key lifetime.
 * Returns 1 when the person was not online before (the due set gained them), else 0.
 */
const TOUCH = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
redis.call('PEXPIRE', KEYS[1], ARGV[5])
local top = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')
return redis.call('ZADD', KEYS[2], top[2], ARGV[4])
`;

/**
 * Removes a connection. KEYS as above. ARGV: now, socket id, user id, debounce.
 * While other connections remain, the person stays online until the latest of them expires.
 * With none left, they are due to go offline after the debounce, unless they come back first.
 */
const DROP = `
redis.call('ZREM', KEYS[1], ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
local top = redis.call('ZRANGE', KEYS[1], -1, -1, 'WITHSCORES')
if #top > 0 then
  redis.call('ZADD', KEYS[2], 'XX', top[2], ARGV[3])
  return 1
end
redis.call('ZADD', KEYS[2], 'XX', tonumber(ARGV[1]) + tonumber(ARGV[4]), ARGV[3])
return 0
`;

/**
 * Finds the people whose time is up. KEYS: the due set. ARGV: now, batch size, key prefix.
 * Someone with a live connection left (their heartbeat was late) stays and is rescheduled.
 * The others are removed and returned: exactly one caller gets each name, so exactly one
 * instance announces it. The per-person keys are built here, which Redis Cluster would not
 * allow: presence assumes a single Redis (or Sentinel), like the rest of the stack.
 */
const SWEEP = `
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, ARGV[2])
local gone = {}
for _, userId in ipairs(ids) do
  local key = ARGV[3] .. userId
  redis.call('ZREMRANGEBYSCORE', key, '-inf', ARGV[1])
  local top = redis.call('ZRANGE', key, -1, -1, 'WITHSCORES')
  if #top > 0 then
    redis.call('ZADD', KEYS[1], top[2], userId)
  else
    redis.call('ZREM', KEYS[1], userId)
    redis.call('DEL', key)
    gone[#gone + 1] = userId
  end
end
return gone
`;

/** One live connection to refresh. */
export interface PresenceBeat {
  socketId: string;
  userId: string;
}

/**
 * Who is online, kept in Redis so every API instance agrees and a crashed instance cannot leave
 * somebody online for ever.
 *
 * - `presence:sockets:{user}` is a sorted set of that person's connections (member: socket id,
 *   score: when it expires). Every API instance refreshes its own connections on a timer, so a
 *   connection whose instance died simply runs out.
 * - `presence:due` has one entry per person who is online as far as anyone has been told (member:
 *   user id, score: when to look again). Being in it *is* the announced state, so "went online"
 *   is a person being added to it, and "went offline" is the sweep removing them.
 *
 * Going offline is debounced: closing the last connection only moves the person's due time to a
 * few seconds from now, and a connection that arrives before then (a page reload, a reconnect to
 * another instance) leaves everything as it was and announces nothing. This needs no timer in
 * any instance, so it survives one crashing.
 */
@Injectable()
export class PresenceService {
  private readonly options: PresenceOptions;

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Optional() @Inject(CORE_OPTIONS) core?: CoreOptions,
  ) {
    this.options = { ...DEFAULT_PRESENCE, ...core?.presence };
    this.redis.defineCommand("presenceTouch", { numberOfKeys: 2, lua: TOUCH });
    this.redis.defineCommand("presenceDrop", { numberOfKeys: 2, lua: DROP });
    this.redis.defineCommand("presenceSweep", { numberOfKeys: 1, lua: SWEEP });
  }

  /** For callers that schedule their own heartbeats: how often is safe is a fraction of this. */
  get socketTtlMs(): number {
    return this.options.socketTtlMs;
  }

  /** A connection opened. True when this made the person come online. */
  async connect(userId: string, socketId: string, now = Date.now()): Promise<boolean> {
    const added = await (this.redis as unknown as Scripts).presenceTouch(
      ...this.touchArgs({ userId, socketId }, now),
    );
    return added === 1;
  }

  /**
   * Refreshes many connections in one round trip. Returns the people who came online because of it:
   * normally nobody, but a person whose entry was swept while their heartbeat was late comes back.
   */
  async heartbeat(beats: readonly PresenceBeat[], now = Date.now()): Promise<string[]> {
    if (beats.length === 0) {
      return [];
    }
    const pipeline = this.redis.pipeline();
    for (const beat of beats) {
      (pipeline as unknown as Scripts).presenceTouch(...this.touchArgs(beat, now));
    }
    const results = (await pipeline.exec()) ?? [];
    const back = new Set<string>();
    results.forEach(([error, added], index) => {
      const beat = beats[index];
      if (beat && !error && added === 1) {
        back.add(beat.userId);
      }
    });
    return [...back];
  }

  /** A connection closed. Nobody is announced offline here: that is the sweep's job, after the debounce. */
  async disconnect(beats: readonly PresenceBeat[], now = Date.now()): Promise<void> {
    if (beats.length === 0) {
      return;
    }
    const pipeline = this.redis.pipeline();
    for (const { userId, socketId } of beats) {
      (pipeline as unknown as Scripts).presenceDrop(
        SOCKETS_KEY + userId,
        DUE_KEY,
        now,
        socketId,
        userId,
        this.options.offlineDebounceMs,
      );
    }
    await pipeline.exec();
  }

  /** People who have just gone offline. Each name is returned to exactly one caller, once. */
  async sweep(now = Date.now(), limit = 200): Promise<string[]> {
    return (await (this.redis as unknown as Scripts).presenceSweep(
      DUE_KEY,
      now,
      limit,
      SOCKETS_KEY,
    )) as string[];
  }

  /** Whether each person is online, as announced. */
  async onlineAmong(userIds: readonly string[]): Promise<Set<string>> {
    const unique = [...new Set(userIds)];
    if (unique.length === 0) {
      return new Set();
    }
    const scores = await this.redis.zmscore(DUE_KEY, ...unique);
    return new Set(unique.filter((_, index) => scores[index] !== null));
  }

  async isOnline(userId: string): Promise<boolean> {
    return (await this.redis.zscore(DUE_KEY, userId)) !== null;
  }

  private touchArgs({ userId, socketId }: PresenceBeat, now: number) {
    return [
      SOCKETS_KEY + userId,
      DUE_KEY,
      now,
      now + this.options.socketTtlMs,
      socketId,
      userId,
      this.options.socketTtlMs * 2,
    ] as const;
  }
}

/** The commands defined above, which ioredis adds to the client at run time. */
interface Scripts {
  presenceDrop: (...args: (string | number)[]) => Promise<unknown>;
  presenceSweep: (...args: (string | number)[]) => Promise<unknown>;
  presenceTouch: (...args: (string | number)[]) => Promise<unknown>;
}
