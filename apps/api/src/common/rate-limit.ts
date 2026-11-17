import { type ExecutionContext, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import {
  ThrottlerGuard,
  type ThrottlerLimitDetail,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from "@nestjs/throttler";
import type { Redis } from "ioredis";

import { DomainError } from "@dovetalk/core";

import type { ApiEnv } from "../config/env.js";
import { RATE_LIMIT_PROFILE, type RateLimitProfile } from "./decorators.js";

/**
 * Counts hits in a fixed window and, once the limit is passed, blocks the key for the rest of
 * the window. One script, so concurrent API instances cannot race each other.
 * Returns { hits, ms until the window ends, blocked (0 or 1), ms until the block ends }.
 */
const HIT_SCRIPT = `
local blockedFor = redis.call('PTTL', KEYS[2])
if blockedFor > 0 then
  local hits = tonumber(redis.call('GET', KEYS[1]) or '0')
  return { hits, redis.call('PTTL', KEYS[1]), 1, blockedFor }
end
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
if hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  return { hits, ttl, 1, tonumber(ARGV[3]) }
end
return { hits, ttl, 0, 0 }
`;

/**
 * Rate-limit counters in Redis, so the limit holds across every API instance.
 * If Redis is unreachable it lets the request through and logs: login should not stop working
 * because the cache is down. Readiness already reports the outage.
 */
type StorageRecord = Awaited<ReturnType<ThrottlerStorage["increment"]>>;

export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger("RateLimit");

  constructor(private readonly redis: Redis) {}

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    _throttlerName: string,
  ): Promise<StorageRecord> {
    try {
      const [hits, ttlMs, blocked, blockMs] = (await this.redis.eval(
        HIT_SCRIPT,
        2,
        `rl:${key}`,
        `rl:${key}:block`,
        ttl,
        limit,
        blockDuration,
      )) as [number, number, number, number];
      return {
        totalHits: hits,
        timeToExpire: Math.ceil(ttlMs / 1000),
        isBlocked: blocked === 1,
        timeToBlockExpire: Math.ceil(blockMs / 1000),
      };
    } catch (error) {
      this.logger.warn({ err: error }, "Rate limit store unavailable, letting the request through");
      return { totalHits: 0, timeToExpire: 0, isBlocked: false, timeToBlockExpire: 0 };
    }
  }
}

interface Limit {
  limit: number;
  windowMs: number;
}
interface Profile {
  email?: Limit;
  ip: Limit;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** The limits each @RateLimit() name stands for, from the environment. `none` has no entry. */
export function rateLimitProfiles(env: ApiEnv): Record<Exclude<RateLimitProfile, "none">, Profile> {
  return {
    default: { ip: { limit: env.RATE_LIMIT_GLOBAL, windowMs: MINUTE } },
    login: {
      ip: { limit: env.RATE_LIMIT_LOGIN_IP, windowMs: MINUTE },
      email: { limit: env.RATE_LIMIT_LOGIN_EMAIL, windowMs: 15 * MINUTE },
    },
    register: { ip: { limit: env.RATE_LIMIT_REGISTER, windowMs: HOUR } },
    guest: { ip: { limit: env.RATE_LIMIT_GUEST, windowMs: HOUR } },
    refresh: { ip: { limit: env.RATE_LIMIT_REFRESH, windowMs: MINUTE } },
  };
}

/** The email in a login body, normalised the way accounts are stored. Undefined if there is none. */
function emailFrom(context: ExecutionContext): string | undefined {
  const { body } = context.switchToHttp().getRequest<{ body?: { email?: unknown } }>();
  const email = body?.email;
  return typeof email === "string" && email.trim()
    ? email.trim().toLowerCase().slice(0, 254)
    : undefined;
}

/**
 * Two counters: one per client IP on every route, and one per email address on routes whose
 * profile has an `email` limit (login). The email counter stops a spread-out guessing attack
 * that no single IP limit would catch.
 */
export function createThrottlerOptions(
  env: ApiEnv,
  redis: Redis,
  reflector = new Reflector(),
): ThrottlerModuleOptions {
  const profiles = rateLimitProfiles(env);
  const profileOf = (context: ExecutionContext): Profile | null => {
    const name =
      reflector.getAllAndOverride<RateLimitProfile | undefined>(RATE_LIMIT_PROFILE, [
        context.getHandler(),
        context.getClass(),
      ]) ?? "default";
    return name === "none" ? null : profiles[name];
  };

  return {
    storage: new RedisThrottlerStorage(redis),
    throttlers: [
      {
        name: "ip",
        limit: (context) => profileOf(context)?.ip.limit ?? Number.MAX_SAFE_INTEGER,
        ttl: (context) => profileOf(context)?.ip.windowMs ?? MINUTE,
        skipIf: (context) => profileOf(context) === null,
      },
      {
        name: "email",
        limit: (context) => profileOf(context)?.email?.limit ?? Number.MAX_SAFE_INTEGER,
        ttl: (context) => profileOf(context)?.email?.windowMs ?? MINUTE,
        getTracker: (_req, context) => emailFrom(context) ?? "",
        skipIf: (context) => !profileOf(context)?.email || emailFrom(context) === undefined,
      },
    ],
  };
}

/** Same counters as ThrottlerGuard, but answers in our error format and with a standard Retry-After. */
export class RateLimitGuard extends ThrottlerGuard {
  protected override async throwThrottlingException(
    context: ExecutionContext,
    detail: ThrottlerLimitDetail,
  ): Promise<void> {
    const seconds = Math.max(1, detail.timeToBlockExpire || detail.timeToExpire);
    context
      .switchToHttp()
      .getResponse<{ setHeader: (name: string, value: number) => void }>()
      .setHeader("Retry-After", seconds);
    throw new DomainError("RATE_LIMITED", "Too many attempts. Wait a moment and try again.");
  }
}
