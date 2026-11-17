import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { newId, schema } from "@dovetalk/db";

import { UsersService } from "../src/users/users.service.js";
import { createTestApp, type TestApp } from "./support/create-test-app.js";
import { PNG } from "./support/http.js";

const { users } = schema;

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const SECRET = new TextEncoder().encode("test-secret-test-secret-test-secret-0123456789");

/** A token like ours, with the knobs a forger or a clock would turn. */
function token(
  sub: string,
  opts: {
    secret?: Uint8Array;
    alg?: string;
    iss?: string;
    aud?: string;
    exp?: string | number;
  } = {},
) {
  return new SignJWT({})
    .setProtectedHeader({ alg: opts.alg ?? "HS256" })
    .setSubject(sub)
    .setIssuer(opts.iss ?? "dovetalk-api")
    .setAudience(opts.aud ?? "dovetalk")
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "15m")
    .sign(opts.secret ?? SECRET);
}

const unauthorized = {
  statusCode: 401,
  code: "UNAUTHORIZED",
  message: "Your session has ended. Sign in again.",
};

describe("the auth guard", () => {
  it("lets a valid access token through", async () => {
    const account = await t.signUp();
    await request(t.server).get("/me").set(account.bearer).expect(200);
  });

  it("answers 401 UNAUTHORIZED with no token", async () => {
    const res = await request(t.server).get("/me").expect(401);
    expect(res.body).toEqual(unauthorized);
  });

  it.each([
    ["a non-Bearer scheme", "Basic dXNlcjpwYXNz"],
    ["an empty Bearer", "Bearer "],
    ["garbage", "Bearer not.a.jwt"],
    ["a token with extra parts", "Bearer a b"],
  ])("answers 401 for %s", async (_label, header) => {
    const res = await request(t.server).get("/me").set("Authorization", header).expect(401);
    expect(res.body).toEqual(unauthorized);
  });

  it("answers 401 for an expired token", async () => {
    const account = await t.signUp();
    const expired = await token(account.user.id, { exp: Math.floor(Date.now() / 1000) - 3600 });
    await request(t.server).get("/me").set("Authorization", `Bearer ${expired}`).expect(401);
  });

  it("answers 401 for a token signed with another secret", async () => {
    const account = await t.signUp();
    const forged = await token(account.user.id, {
      secret: new TextEncoder().encode("x".repeat(48)),
    });
    await request(t.server).get("/me").set("Authorization", `Bearer ${forged}`).expect(401);
  });

  it("answers 401 for the wrong algorithm, issuer or audience", async () => {
    const account = await t.signUp();
    for (const bad of [
      await token(account.user.id, { alg: "HS512" }),
      await token(account.user.id, { iss: "someone-else" }),
      await token(account.user.id, { aud: "another-app" }),
    ]) {
      await request(t.server).get("/me").set("Authorization", `Bearer ${bad}`).expect(401);
    }
  });

  it("answers 401 for an unsigned token (alg none)", async () => {
    const account = await t.signUp();
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const unsigned = `${b64({ alg: "none", typ: "JWT" })}.${b64({
      sub: account.user.id,
      iss: "dovetalk-api",
      aud: "dovetalk",
      exp: Math.floor(Date.now() / 1000) + 600,
    })}.`;
    await request(t.server).get("/me").set("Authorization", `Bearer ${unsigned}`).expect(401);
  });

  it("answers 401 for a token with no subject", async () => {
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("dovetalk-api")
      .setAudience("dovetalk")
      .setExpirationTime("15m")
      .sign(SECRET);
    await request(t.server).get("/me").set("Authorization", `Bearer ${forged}`).expect(401);
  });

  it("answers 401 for a valid token whose user no longer exists", async () => {
    const account = await t.signUp();
    await t.db.delete(users).where(eq(users.id, account.user.id));
    await request(t.server).get("/me").set(account.bearer).expect(401);
    await request(t.server)
      .get("/me")
      .set("Authorization", `Bearer ${await token(newId())}`)
      .expect(401);
  });

  it("answers 401 for a token naming a bot", async () => {
    const [bot] = await t.db.insert(users).values({ name: "Bot", hue: 1, isBot: true }).returning();
    await request(t.server)
      .get("/me")
      .set("Authorization", `Bearer ${await token(bot!.id)}`)
      .expect(401);
  });

  it("ignores a bad token on public routes, so a stale one cannot block signing in", async () => {
    const account = await t.signUp();
    await request(t.server)
      .post("/auth/login")
      .set("Authorization", "Bearer garbage")
      .send({ email: account.email, password: account.password })
      .expect(200);
    await request(t.server).get("/health/live").set("Authorization", "Bearer garbage").expect(200);
  });

  it("remembers a user between requests when the cache is on, and only then", async () => {
    const cached = await createTestApp({ AUTH_CACHE_TTL_MS: "60000" });
    try {
      const account = await cached.signUp();
      const find = vi.spyOn(cached.db, "select");
      await request(cached.server).get("/me").set(account.bearer).expect(200);
      const afterFirst = find.mock.calls.length;
      await request(cached.server).get("/me").set(account.bearer).expect(200);
      // The second call adds only the /me query itself, not another guard lookup.
      expect(find.mock.calls.length - afterFirst).toBe(1);
    } finally {
      await cached.close();
    }
  });
});

describe("GET /me", () => {
  it("returns the profile", async () => {
    const account = await t.signUp({ name: "Dana", phone: "+1 555 010 0199" });
    const res = await request(t.server).get("/me").set(account.bearer).expect(200);
    expect(res.body).toEqual({
      id: account.user.id,
      email: account.email,
      name: "Dana",
      about: "Hey there, I am using Dovetalk.",
      avatarUrl: null,
      hue: expect.any(Number),
      phone: "+1 555 010 0199",
      preferences: { sounds: true, previews: true, enterToSend: true },
    });
  });
});

describe("PATCH /me", () => {
  const patch = (account: { bearer: Record<string, string> }, body: unknown) =>
    request(t.server)
      .patch("/me")
      .set(account.bearer)
      .send(body as object);

  it("changes only the fields that were sent", async () => {
    const account = await t.signUp({ name: "Before" });
    const res = await patch(account, { name: "  After  ", about: "Coffee first." }).expect(200);
    expect(res.body).toMatchObject({ name: "After", about: "Coffee first.", email: account.email });
    expect(res.body.hue).toBe(account.user.hue);
    const again = await request(t.server).get("/me").set(account.bearer).expect(200);
    expect(again.body).toEqual(res.body);
  });

  it("merges preferences instead of replacing them", async () => {
    const account = await t.signUp();
    const first = await patch(account, { preferences: { sounds: false } }).expect(200);
    expect(first.body.preferences).toEqual({ sounds: false, previews: true, enterToSend: true });
    const second = await patch(account, { preferences: { enterToSend: false } }).expect(200);
    expect(second.body.preferences).toEqual({ sounds: false, previews: true, enterToSend: false });
  });

  it("does not lose a setting when two devices change different ones at once", async () => {
    const account = await t.signUp();
    await Promise.all([
      patch(account, { preferences: { sounds: false } }),
      patch(account, { preferences: { previews: false } }),
      patch(account, { preferences: { enterToSend: false } }),
    ]);
    const res = await request(t.server).get("/me").set(account.bearer).expect(200);
    expect(res.body.preferences).toEqual({ sounds: false, previews: false, enterToSend: false });
  });

  it("treats an empty patch as a read", async () => {
    const account = await t.signUp();
    const res = await patch(account, {}).expect(200);
    expect(res.body).toEqual(account.user);
    await patch(account, { preferences: {} }).expect(200);
  });

  it("sets and removes the phone number", async () => {
    const account = await t.signUp();
    const set = await patch(account, { phone: "(555) 010-0142" }).expect(200);
    expect(set.body.phone).toBe("(555) 010-0142");
    const removed = await patch(account, { phone: null }).expect(200);
    expect(removed.body.phone).toBeNull();
  });

  it("answers 409 PHONE_TAKEN when someone else has the number, however it is written", async () => {
    await t.signUp({ phone: "+49 30 901820" });
    const other = await t.signUp();
    const res = await patch(other, { phone: "4930901820" }).expect(409);
    expect(res.body).toEqual({
      statusCode: 409,
      code: "PHONE_TAKEN",
      message: "That phone number is already in use.",
    });
    // Keeping your own number is not a conflict.
    const mine = await t.signUp({ phone: "+49 30 555555" });
    await patch(mine, { phone: "+49 30 555555", name: "Me" }).expect(200);
  });

  it.each([
    ["a blank name", { name: "  " }, "Name can't be empty."],
    ["a null name", { name: null }, "Name can't be empty."],
    ["a long name", { name: "n".repeat(61) }, "Name can be at most 60 characters."],
    ["a long about", { about: "a".repeat(141) }, "About can be at most 140 characters."],
    ["a null about", { about: null }, "About must be text."],
    ["a short phone", { phone: "123" }, "Enter a phone number with 7 to 15 digits."],
    ["a non-boolean preference", { preferences: { sounds: "yes" } }, "Sounds must be on or off."],
    [
      "preferences that are not an object",
      { preferences: "loud" },
      "Preferences must be an object.",
    ],
  ])("answers 422 for %s", async (_label, body, message) => {
    const account = await t.signUp();
    const res = await patch(account, body).expect(422);
    expect(res.body).toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.arrayContaining([message]),
    });
  });

  it("accepts removing the photo, and refuses any URL that is not one of our own uploads", async () => {
    const account = await t.signUp();
    const removed = await patch(account, { avatarUrl: null }).expect(200);
    expect(removed.body.avatarUrl).toBeNull();
    for (const avatarUrl of [
      "https://evil.example/tracker.png",
      "data:image/png;base64,AAAA",
      "javascript:alert(1)",
    ]) {
      const res = await patch(account, { avatarUrl }).expect(422);
      expect(res.body.message).toEqual(["That image can't be used as a profile photo."]);
    }
  });

  it("accepts the link of the person's own uploaded picture (the rest is in uploads.test.ts)", async () => {
    const account = await t.signUp();
    const up = await request(t.server)
      .post("/uploads")
      .set(account.bearer)
      .attach("file", PNG, { filename: "me.png", contentType: "image/png" })
      .expect(201);
    const res = await patch(account, { avatarUrl: up.body.url }).expect(200);
    expect(res.body.avatarUrl).toMatch(/^https?:\/\//u);
    expect(res.body.avatarUrl).not.toBe(up.body.id);
  });

  it("cannot change the email, id or anything else the person does not own", async () => {
    const account = await t.signUp();
    const res = await patch(account, {
      email: "hijack@example.com",
      id: newId(),
      isBot: true,
      passwordHash: "x",
      hue: 1,
    }).expect(200);
    expect(res.body).toEqual(account.user);
    const [row] = await t.db.select().from(users).where(eq(users.id, account.user.id));
    expect(row).toMatchObject({ email: account.email, isBot: false });
  });

  it("only ever changes the signed-in person", async () => {
    const a = await t.signUp({ name: "A" });
    const b = await t.signUp({ name: "B" });
    await patch(a, { name: "A2" }).expect(200);
    const res = await request(t.server).get("/me").set(b.bearer).expect(200);
    expect(res.body.name).toBe("B");
  });

  it("answers 401 without a token", async () => {
    await request(t.server).patch("/me").send({ name: "x" }).expect(401);
  });

  it("answers 401 if the person was deleted between the guard and the update", async () => {
    const account = await t.signUp();
    const spy = vi.spyOn(UsersService.prototype, "updateProfile");
    await t.db.delete(users).where(eq(users.id, account.user.id));
    await patch(account, { name: "Ghost" }).expect(401);
    spy.mockRestore();
  });
});
