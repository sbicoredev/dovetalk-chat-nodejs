import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { HealthChecks } from "@dovetalk/core";

import { createTestApp, type TestApp } from "./support/create-test-app.js";

let t: TestApp;

beforeAll(async () => {
  t = await createTestApp();
});

afterAll(() => t.close());

describe("health", () => {
  it("GET /health/live answers without touching dependencies", async () => {
    const res = await request(t.server).get("/health/live").expect(200);
    expect(res.body).toMatchObject({ status: "ok", version: "dev" });
  });

  it("tags every response with a request id and keeps a sane one from the caller", async () => {
    const made = await request(t.server).get("/health/live");
    expect(made.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/u);

    const kept = await request(t.server).get("/health/live").set("X-Request-Id", "trace-abc.123");
    expect(kept.headers["x-request-id"]).toBe("trace-abc.123");

    const replaced = await request(t.server)
      .get("/health/live")
      .set("X-Request-Id", "bad id\u0020with spaces");
    expect(replaced.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it("GET /health/ready is ok with Postgres and Redis up", async () => {
    const res = await request(t.server).get("/health/ready").expect(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.info).toHaveProperty("database");
    expect(res.body.info).toHaveProperty("cache");
  });

  it("GET /health/ready returns 503 while draining", async () => {
    t.app.get(HealthChecks).shutdown.begin();
    const res = await request(t.server).get("/health/ready").expect(503);
    expect(res.body.error).toHaveProperty("shutdown");
  });
});

describe("http setup", () => {
  it("sets security headers and exposes no framework banner", async () => {
    const res = await request(t.server).get("/health/live");
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("allows only the configured origin", async () => {
    const allowed = await request(t.server)
      .get("/health/live")
      .set("Origin", "http://localhost:3000");
    expect(allowed.headers["access-control-allow-origin"]).toBe("http://localhost:3000");
    expect(allowed.headers["access-control-allow-credentials"]).toBe("true");

    const denied = await request(t.server)
      .get("/health/live")
      .set("Origin", "https://evil.example");
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("serves the OpenAPI page", async () => {
    await request(t.server).get("/docs-json").expect(200);
  });
});
