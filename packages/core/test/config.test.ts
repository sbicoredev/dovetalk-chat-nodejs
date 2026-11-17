import { describe, expect, it } from "vitest";

import { baseEnvSchema, ConfigError, parseEnv } from "../src/index.js";

const valid = {
  DATABASE_URL: "postgres://u:p@localhost:5432/db",
  REDIS_URL: "redis://localhost:6379",
};

describe("parseEnv", () => {
  it("fills in defaults", () => {
    const env = parseEnv(baseEnvSchema, valid, "test");
    expect(env).toMatchObject({
      NODE_ENV: "development",
      LOG_LEVEL: "info",
      LOG_PRETTY: false,
      DATABASE_POOL_MAX: 10,
    });
  });

  it("coerces numbers and booleans from strings", () => {
    const env = parseEnv(
      baseEnvSchema,
      { ...valid, DATABASE_POOL_MAX: "25", LOG_PRETTY: "true", SHUTDOWN_DRAIN_MS: "5000" },
      "test",
    );
    expect(env.DATABASE_POOL_MAX).toBe(25);
    expect(env.LOG_PRETTY).toBe(true);
    expect(env.SHUTDOWN_DRAIN_MS).toBe(5000);
  });

  it("treats empty strings as unset", () => {
    const env = parseEnv(baseEnvSchema, { ...valid, LOG_LEVEL: "", DATABASE_POOL_MAX: "" }, "test");
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.DATABASE_POOL_MAX).toBe(10);
  });

  it("reports every problem at once", () => {
    let caught: unknown;
    try {
      parseEnv(
        baseEnvSchema,
        { DATABASE_URL: "mysql://x/y", DATABASE_POOL_MAX: "0" },
        "dovetalk-api",
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const { message, problems: list } = caught as ConfigError;
    const problems = list.join("\n");
    expect(problems).toContain("DATABASE_URL");
    expect(problems).toContain("REDIS_URL");
    expect(problems).toContain("DATABASE_POOL_MAX");
    expect(message).toContain("dovetalk-api");
  });
});
