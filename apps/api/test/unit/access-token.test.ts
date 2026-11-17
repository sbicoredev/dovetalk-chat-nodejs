import { decodeJwt, decodeProtectedHeader } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccessTokenService } from "../../src/auth/access-token.service.js";
import { loadApiEnv } from "../../src/config/env.js";

const env = (over: Record<string, string> = {}) =>
  loadApiEnv({
    DATABASE_URL: "postgres://x@localhost/x",
    REDIS_URL: "redis://localhost",
    JWT_SECRET: "a".repeat(40),
    S3_ENDPOINT: "http://localhost:8333",
    S3_BUCKET: "dovetalk",
    S3_ACCESS_KEY_ID: "key",
    S3_SECRET_ACCESS_KEY: "secret",
    ...over,
  });

beforeEach(() => vi.useFakeTimers({ now: new Date("2026-11-13T10:00:00Z") }));
afterEach(() => vi.useRealTimers());

describe("AccessTokenService", () => {
  it("signs a token for a user and gives the user id back", async () => {
    const service = new AccessTokenService(env());
    const token = await service.sign("user-1");
    expect(await service.verify(token)).toBe("user-1");
  });

  it("carries only the subject and the standard claims", async () => {
    const token = await new AccessTokenService(env()).sign("user-1");
    expect(decodeProtectedHeader(token)).toEqual({ alg: "HS256", typ: "at+jwt" });
    expect(decodeJwt(token)).toEqual({
      sub: "user-1",
      iss: "dovetalk-api",
      aud: "dovetalk",
      iat: 1_794_564_000,
      exp: 1_794_564_000 + 900,
    });
  });

  it("expires after ACCESS_TOKEN_TTL_SECONDS, with a few seconds of clock tolerance", async () => {
    const service = new AccessTokenService(env({ ACCESS_TOKEN_TTL_SECONDS: "120" }));
    const token = await service.sign("user-1");
    vi.advanceTimersByTime(124_000);
    expect(await service.verify(token)).toBe("user-1");
    vi.advanceTimersByTime(2000);
    expect(await service.verify(token)).toBeNull();
  });

  it("rejects a token signed with a different secret, and one that was tampered with", async () => {
    const token = await new AccessTokenService(env()).sign("user-1");
    expect(
      await new AccessTokenService(env({ JWT_SECRET: "b".repeat(40) })).verify(token),
    ).toBeNull();

    const [head, , sig] = token.split(".");
    const forgedBody = Buffer.from(
      JSON.stringify({ sub: "admin", iss: "dovetalk-api", aud: "dovetalk", exp: 9_999_999_999 }),
    ).toString("base64url");
    expect(await new AccessTokenService(env()).verify(`${head}.${forgedBody}.${sig}`)).toBeNull();
  });

  it("returns null for anything that is not a token, and never throws", async () => {
    const service = new AccessTokenService(env());
    for (const junk of ["", "x", "a.b.c", "Bearer x", "\u0000", "a".repeat(10_000)]) {
      expect(await service.verify(junk)).toBeNull();
    }
  });
});
