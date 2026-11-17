import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { UsersService } from "../src/users/users.service.js";
import { createTestApp, TEST_ORIGIN, type TestApp } from "./support/create-test-app.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

describe("error responses", () => {
  it("answers an unknown route with the standard JSON body", async () => {
    const res = await request(t.server).get("/no/such/route").expect(404);
    expect(res.body).toEqual({
      statusCode: 404,
      code: "NOT_FOUND",
      message: "That doesn't exist.",
    });
  });

  it("answers broken JSON with 400 BAD_REQUEST", async () => {
    const res = await request(t.server)
      .post("/auth/login")
      .set("Content-Type", "application/json")
      .send('{"email": ')
      .expect(400);
    expect(res.body).toEqual({
      statusCode: 400,
      code: "BAD_REQUEST",
      message: "The request body isn't valid JSON.",
    });
  });

  it("answers an oversized body with 413 PAYLOAD_TOO_LARGE", async () => {
    const res = await request(t.server)
      .post("/auth/login")
      .send({ email: "a@b.co", password: "x".repeat(300_000) })
      .expect(413);
    expect(res.body).toMatchObject({ statusCode: 413, code: "PAYLOAD_TOO_LARGE" });
  });

  it("never leaks the cause of an unexpected failure", async () => {
    const account = await t.signUp();
    const boom = vi
      .spyOn(UsersService.prototype, "findById")
      .mockRejectedValue(
        new Error('password authentication failed for user "dovetalk" at 10.0.0.5'),
      );
    try {
      const res = await request(t.server).get("/me").set(account.bearer).expect(500);
      expect(res.body).toEqual({
        statusCode: 500,
        code: "INTERNAL_ERROR",
        message: "Something went wrong on our side. Try again in a moment.",
      });
      expect(JSON.stringify(res.body)).not.toMatch(/password|10\.0\.0\.5/u);
    } finally {
      boom.mockRestore();
    }
  });

  it("puts a request id on errors, and echoes a sane one from the caller", async () => {
    const generated = await request(t.server).get("/no/such/route").expect(404);
    expect(generated.headers["x-request-id"]).toMatch(/^[\w-]{8,}$/u);
    const echoed = await request(t.server)
      .get("/no/such/route")
      .set("X-Request-Id", "abc-12345")
      .expect(404);
    expect(echoed.headers["x-request-id"]).toBe("abc-12345");
  });
});

describe("CORS", () => {
  it("lets the web app call with credentials and read the request id", async () => {
    const res = await request(t.server)
      .options("/auth/refresh")
      .set("Origin", TEST_ORIGIN)
      .set("Access-Control-Request-Method", "POST")
      .expect(204);
    expect(res.headers["access-control-allow-origin"]).toBe(TEST_ORIGIN);
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("gives other sites nothing", async () => {
    const res = await request(t.server)
      .options("/auth/refresh")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "POST");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});
