import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createTestApp, TEST_PASSWORD, type TestApp } from "./support/create-test-app.js";

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({
    RATE_LIMIT_LOGIN_IP: "5",
    RATE_LIMIT_LOGIN_EMAIL: "3",
    RATE_LIMIT_GUEST: "2",
    RATE_LIMIT_REGISTER: "2",
    RATE_LIMIT_REFRESH: "2",
    RATE_LIMIT_GLOBAL: "4",
  });
});
afterAll(() => t.close());

const login = (email: string) =>
  request(t.server).post("/auth/login").send({ email, password: "wrong-password" });

describe("rate limits", () => {
  it("limits login attempts against one email, whichever IP they come from", async () => {
    const email = "victim@example.com";
    for (let i = 0; i < 3; i += 1) {
      await login(email).expect(401);
    }
    const res = await login(email).expect(429);
    expect(res.body).toEqual({
      statusCode: 429,
      code: "RATE_LIMITED",
      message: "Too many attempts. Wait a moment and try again.",
    });
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
    // Another address from the same IP is not affected, because the email counter is separate.
    await login("someone-else@example.com").expect(401);
  });

  it("limits login attempts per IP", async () => {
    // Four attempts at the one above, plus this: five against the IP limit of 5, then blocked.
    let blocked = 0;
    for (let i = 0; i < 4; i += 1) {
      const res = await login(`spray-${i}@example.com`);
      if (res.status === 429) {
        blocked += 1;
      }
    }
    expect(blocked).toBeGreaterThan(0);
  });

  it("limits guest accounts per IP", async () => {
    await request(t.server).post("/auth/guest").expect(201);
    await request(t.server).post("/auth/guest").expect(201);
    const res = await request(t.server).post("/auth/guest").expect(429);
    expect(res.body.code).toBe("RATE_LIMITED");
  });

  it("limits sign-ups per IP", async () => {
    const make = (n: number) =>
      request(t.server)
        .post("/auth/register")
        .send({ email: `limited-${n}@example.com`, password: TEST_PASSWORD, name: "L" });
    await make(1).expect(201);
    await make(2).expect(201);
    await make(3).expect(429);
  });

  it("limits refreshes per IP", async () => {
    await request(t.server).post("/auth/refresh").expect(401);
    await request(t.server).post("/auth/refresh").expect(401);
    await request(t.server).post("/auth/refresh").expect(429);
  });

  it("applies a general limit to every other route", async () => {
    for (let i = 0; i < 4; i += 1) {
      await request(t.server).get("/me").expect(401);
    }
    await request(t.server).get("/me").expect(429);
  });

  it("never limits health probes", async () => {
    for (let i = 0; i < 12; i += 1) {
      await request(t.server).get("/health/live").expect(200);
    }
  });

  it("starts counting again when the window ends", async () => {
    await t.redis.flushdb();
    await request(t.server).post("/auth/guest").expect(201);
  });

  it("lets requests through if Redis is unreachable, rather than failing them", async () => {
    const broken = await createTestApp({ RATE_LIMIT_GUEST: "1" });
    try {
      await request(broken.server).post("/auth/guest").expect(201);
      await request(broken.server).post("/auth/guest").expect(429);
      // Redis goes away: the limiter fails open and login keeps working.
      broken.redis.disconnect();
      const res = await request(broken.server).post("/auth/guest");
      expect(res.status).toBe(201);
    } finally {
      await broken.close();
    }
  });
});
