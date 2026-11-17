import { z } from "zod";

import { baseEnvSchema, parseEnv, storageEnvShape } from "@dovetalk/core";

const DIGITS_ONLY = /^\d+$/u;

const origin = z.url({ protocol: /^https?$/u }).refine((value) => new URL(value).origin === value, {
  message:
    "must be an origin without a path or trailing slash, for example https://app.example.com",
});

const positiveInt = (fallback: number) => z.coerce.number().int().min(1).default(fallback);

/** Marks the placeholder secret in .env.example, so it cannot reach production by accident. */
const EXAMPLE_SECRET_PREFIX = "dev-only";

export const apiEnvSchema = baseEnvSchema
  .extend({
    ...storageEnvShape,

    HOST: z.string().min(1).default("0.0.0.0"),
    PORT: z.coerce.number().int().min(0).max(65_535).default(3001),

    /** Web app origins allowed to call the API, comma separated. Empty means no cross-origin access. */
    CORS_ORIGINS: z
      .string()
      .default("")
      .transform((value) =>
        value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean),
      )
      .pipe(z.array(origin)),

    /**
     * How many reverse proxies sit in front of the API: a number, "true", "false" or an Express
     * subnet name such as "loopback". Needed for real client IPs, which rate limits depend on.
     */
    TRUST_PROXY: z
      .string()
      .default("false")
      .transform((value): boolean | number | string => {
        if (value === "true") {
          return true;
        }
        if (value === "false") {
          return false;
        }
        return DIGITS_ONLY.test(value) ? Number(value) : value;
      }),

    /** The OpenAPI page at /docs. On by default outside production. */
    SWAGGER_ENABLED: z.stringbool().optional(),

    // ---- Authentication ----------------------------------------------------------------

    /** Signs access tokens. Every API instance must share it. Generate one: openssl rand -base64 48 */
    JWT_SECRET: z
      .string()
      .min(32, "must be at least 32 characters. Generate one with: openssl rand -base64 48"),
    ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    /**
     * A refresh token that was already exchanged is still accepted for this long, because two
     * tabs (or React StrictMode) can send the same cookie at once. After it, reuse revokes the
     * whole sign-in. See docs/edge-cases.md #26.
     */
    REFRESH_REUSE_WINDOW_MS: z.coerce.number().int().min(0).max(60_000).default(10_000),
    /** How long the guard remembers that a user still exists. 0 checks the database every time. */
    AUTH_CACHE_TTL_MS: z.coerce.number().int().min(0).default(30_000),

    // The refresh-token cookie. Defaults suit a web app and API on the same site.
    /** Defaults to true in production. Safari ignores Secure cookies on plain http://localhost. */
    COOKIE_SECURE: z.stringbool().optional(),
    COOKIE_SAMESITE: z.enum(["lax", "strict", "none"]).default("lax"),
    COOKIE_DOMAIN: z.string().min(1).optional(),
    /** Behind the Next.js /api proxy this is "/api/auth". */
    COOKIE_PATH: z.string().startsWith("/", "must start with /").default("/auth"),

    // ---- Realtime ----------------------------------------------------------------------

    /** How often each instance tells Redis its connections are still alive. */
    PRESENCE_HEARTBEAT_MS: positiveInt(15_000),
    /** A connection not refreshed for this long is treated as gone, which is how a crashed instance's people go offline. */
    PRESENCE_SOCKET_TTL_MS: positiveInt(45_000),
    /** After a person's last connection closes, wait this long before saying offline, so a page reload does not flap. */
    PRESENCE_OFFLINE_DEBOUNCE_MS: z.coerce.number().int().min(0).default(5000),
    /** How often each instance looks for people whose time is up. */
    PRESENCE_SWEEP_MS: positiveInt(1000),

    // ---- Background jobs ---------------------------------------------------------------

    /**
     * Whether a message to a bot sets the bot answering (jobs the worker runs). Turn it off for
     * a deployment with no worker, so nothing piles up in Redis.
     */
    BOT_REPLIES_ENABLED: z.stringbool().default(true),

    // ---- Rate limits (requests per window, per client IP unless noted) -----------------

    /** Per route, per minute. A safety net for every endpoint without its own limit. */
    RATE_LIMIT_GLOBAL: positiveInt(600),
    /** Login attempts per minute. */
    RATE_LIMIT_LOGIN_IP: positiveInt(20),
    /** Login attempts per 15 minutes against one email address, from anywhere. */
    RATE_LIMIT_LOGIN_EMAIL: positiveInt(10),
    /** Sign-ups per hour. */
    RATE_LIMIT_REGISTER: positiveInt(20),
    /** Guest accounts per hour. */
    RATE_LIMIT_GUEST: positiveInt(30),
    /** Token refreshes per minute. */
    RATE_LIMIT_REFRESH: positiveInt(60),
  })
  .superRefine((env, ctx) => {
    // One missed heartbeat must not take somebody offline: the lifetime has to cover at least two.
    if (env.PRESENCE_SOCKET_TTL_MS < env.PRESENCE_HEARTBEAT_MS * 2) {
      ctx.addIssue({
        code: "custom",
        path: ["PRESENCE_SOCKET_TTL_MS"],
        message:
          "must be at least twice PRESENCE_HEARTBEAT_MS, so one late heartbeat is survivable.",
      });
    }
    const secure = env.COOKIE_SECURE ?? env.NODE_ENV === "production";
    if (env.COOKIE_SAMESITE === "none" && !secure) {
      ctx.addIssue({
        code: "custom",
        path: ["COOKIE_SAMESITE"],
        message: 'is "none", which browsers only accept on Secure cookies. Set COOKIE_SECURE=true.',
      });
    }
    if (env.NODE_ENV === "production" && env.JWT_SECRET.startsWith(EXAMPLE_SECRET_PREFIX)) {
      ctx.addIssue({
        code: "custom",
        path: ["JWT_SECRET"],
        message: "is the placeholder from .env.example. Set a real secret in production.",
      });
    }
  });

export type ApiEnv = Omit<z.infer<typeof apiEnvSchema>, "SWAGGER_ENABLED" | "COOKIE_SECURE"> & {
  SWAGGER_ENABLED: boolean;
  COOKIE_SECURE: boolean;
};

export function loadApiEnv(env: Record<string, string | undefined> = process.env): ApiEnv {
  const parsed = parseEnv(apiEnvSchema, env, "dovetalk-api");
  return {
    ...parsed,
    SWAGGER_ENABLED: parsed.SWAGGER_ENABLED ?? parsed.NODE_ENV !== "production",
    COOKIE_SECURE: parsed.COOKIE_SECURE ?? parsed.NODE_ENV === "production",
  };
}

export const API_ENV = Symbol("API_ENV");
