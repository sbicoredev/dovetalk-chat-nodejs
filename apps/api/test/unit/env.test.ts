import { describe, expect, it } from "vitest";

import { ConfigError } from "@dovetalk/core";

import { loadApiEnv } from "../../src/config/env.js";

const base = {
  DATABASE_URL: "postgres://x@localhost/x",
  REDIS_URL: "redis://localhost",
  JWT_SECRET: "s".repeat(40),
  S3_ENDPOINT: "http://localhost:8333",
  S3_BUCKET: "dovetalk",
  S3_ACCESS_KEY_ID: "key",
  S3_SECRET_ACCESS_KEY: "secret",
};

describe("API environment", () => {
  it("fills in safe defaults", () => {
    const env = loadApiEnv(base);
    expect(env).toMatchObject({
      ACCESS_TOKEN_TTL_SECONDS: 900,
      REFRESH_TOKEN_TTL_DAYS: 30,
      REFRESH_REUSE_WINDOW_MS: 10_000,
      COOKIE_SAMESITE: "lax",
      COOKIE_PATH: "/auth",
      COOKIE_SECURE: false,
      RATE_LIMIT_LOGIN_IP: 20,
      RATE_LIMIT_LOGIN_EMAIL: 10,
    });
  });

  it("has presence defaults that survive one late heartbeat", () => {
    expect(loadApiEnv(base)).toMatchObject({
      PRESENCE_HEARTBEAT_MS: 15_000,
      PRESENCE_SOCKET_TTL_MS: 45_000,
      PRESENCE_OFFLINE_DEBOUNCE_MS: 5000,
      PRESENCE_SWEEP_MS: 1000,
    });
  });

  it("refuses a presence lifetime shorter than two heartbeats, and accepts exactly two", () => {
    expect(() =>
      loadApiEnv({ ...base, PRESENCE_HEARTBEAT_MS: "10000", PRESENCE_SOCKET_TTL_MS: "19999" }),
    ).toThrow(/PRESENCE_SOCKET_TTL_MS.*twice PRESENCE_HEARTBEAT_MS/su);
    expect(
      loadApiEnv({ ...base, PRESENCE_HEARTBEAT_MS: "10000", PRESENCE_SOCKET_TTL_MS: "20000" }),
    ).toMatchObject({ PRESENCE_SOCKET_TTL_MS: 20_000 });
    // Raising only the heartbeat leaves the default lifetime too short: say so rather than flap.
    expect(() => loadApiEnv({ ...base, PRESENCE_HEARTBEAT_MS: "30000" })).toThrow(
      /PRESENCE_SOCKET_TTL_MS/u,
    );
  });

  it("lets the offline debounce be zero, and treats an empty value as unset", () => {
    expect(
      loadApiEnv({ ...base, PRESENCE_OFFLINE_DEBOUNCE_MS: "0" }).PRESENCE_OFFLINE_DEBOUNCE_MS,
    ).toBe(0);
    expect(
      loadApiEnv({ ...base, PRESENCE_OFFLINE_DEBOUNCE_MS: "" }).PRESENCE_OFFLINE_DEBOUNCE_MS,
    ).toBe(5000);
  });

  it("makes the cookie Secure in production unless told otherwise", () => {
    expect(loadApiEnv({ ...base, NODE_ENV: "production" }).COOKIE_SECURE).toBe(true);
    expect(
      loadApiEnv({ ...base, NODE_ENV: "production", COOKIE_SECURE: "false" }).COOKIE_SECURE,
    ).toBe(false);
  });

  it("refuses a JWT secret that is missing or short, naming the variable and the fix", () => {
    const { JWT_SECRET: _omitted, ...missing } = base;
    expect(() => loadApiEnv(missing)).toThrow(ConfigError);
    expect(() => loadApiEnv(missing)).toThrow(/JWT_SECRET/u);
    expect(() => loadApiEnv({ ...base, JWT_SECRET: "short" })).toThrow(
      /at least 32 characters.*openssl/su,
    );
  });

  it("needs object storage settings, and names the ones that are missing", () => {
    const { S3_ENDPOINT: _a, S3_BUCKET: _b, ...without } = base;
    expect(() => loadApiEnv(without)).toThrow(/S3_ENDPOINT/u);
    expect(() => loadApiEnv(without)).toThrow(/S3_BUCKET/u);
    expect(loadApiEnv(base).S3_FORCE_PATH_STYLE).toBe(true);
  });

  it("refuses the placeholder secret from .env.example in production", () => {
    const placeholder = { ...base, JWT_SECRET: "dev-only-change-me-dev-only-change-me-0000" };
    expect(() => loadApiEnv({ ...placeholder, NODE_ENV: "production" })).toThrow(/placeholder/u);
    expect(loadApiEnv({ ...placeholder, NODE_ENV: "development" }).JWT_SECRET).toBe(
      placeholder.JWT_SECRET,
    );
  });

  it("refuses SameSite=None without Secure, which browsers would drop", () => {
    expect(() => loadApiEnv({ ...base, COOKIE_SAMESITE: "none" })).toThrow(/COOKIE_SAMESITE/u);
    expect(
      loadApiEnv({ ...base, COOKIE_SAMESITE: "none", COOKIE_SECURE: "true" }).COOKIE_SAMESITE,
    ).toBe("none");
  });

  it("validates numbers and the cookie path", () => {
    expect(() => loadApiEnv({ ...base, ACCESS_TOKEN_TTL_SECONDS: "5" })).toThrow(
      /ACCESS_TOKEN_TTL_SECONDS/u,
    );
    expect(() => loadApiEnv({ ...base, RATE_LIMIT_LOGIN_IP: "0" })).toThrow(/RATE_LIMIT_LOGIN_IP/u);
    expect(() => loadApiEnv({ ...base, COOKIE_PATH: "auth" })).toThrow(/COOKIE_PATH/u);
  });

  it("reports every problem at once", () => {
    let message = "";
    try {
      loadApiEnv({ DATABASE_URL: "nope", ACCESS_TOKEN_TTL_SECONDS: "1" });
    } catch (error) {
      ({ message } = error as Error);
    }
    for (const name of ["DATABASE_URL", "REDIS_URL", "JWT_SECRET", "ACCESS_TOKEN_TTL_SECONDS"]) {
      expect(message).toContain(name);
    }
  });
});
