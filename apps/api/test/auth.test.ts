import { eq, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { GUEST_EMAIL_DOMAIN } from "@dovetalk/contracts";
import { newId, schema } from "@dovetalk/db";

import { PasswordService } from "../src/auth/password.service.js";
import {
  createTestApp,
  refreshTokenFrom,
  setCookies,
  TEST_PASSWORD,
  type TestApp,
} from "./support/create-test-app.js";

const { users, refreshTokens } = schema;

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const post = (path: string) => request(t.server).post(path);

describe("POST /auth/register", () => {
  it("creates the account, signs in and sets the refresh cookie", async () => {
    const res = await post("/auth/register")
      .send({ email: "sam@example.com", password: TEST_PASSWORD, name: "Sam Lee" })
      .expect(201);

    expect(res.body).toEqual({
      accessToken: expect.stringMatching(/^[\w-]+\.[\w-]+\.[\w-]+$/u),
      user: {
        id: expect.stringMatching(/^[0-9a-f-]{36}$/u),
        email: "sam@example.com",
        name: "Sam Lee",
        about: "Hey there, I am using Dovetalk.",
        avatarUrl: null,
        hue: expect.any(Number),
        phone: null,
        preferences: { sounds: true, previews: true, enterToSend: true },
      },
    });
    expect(res.body.user.hue).toBeGreaterThanOrEqual(0);
    expect(res.body.user.hue).toBeLessThan(360);
    expect(JSON.stringify(res.body)).not.toMatch(/argon2|password_hash|passwordHash/u);

    const cookie = setCookies(res.headers["set-cookie"]).find((c) => c.startsWith("dt_refresh="))!;
    expect(cookie).toMatch(/; Path=\/auth;/u);
    expect(cookie).toMatch(/; HttpOnly/u);
    expect(cookie).toMatch(/; SameSite=Lax/u);
    expect(cookie).toMatch(/; Expires=/u);
    expect(cookie).not.toMatch(/Secure/u); // off outside production
  });

  it("stores an Argon2id hash, never the password", async () => {
    const account = await t.signUp();
    const [row] = await t.db.select().from(users).where(eq(users.id, account.user.id));
    expect(row!.passwordHash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);
    expect(row!.passwordHash).not.toContain(TEST_PASSWORD);
  });

  it("stores only a hash of the refresh token", async () => {
    const account = await t.signUp();
    const rows = await t.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, account.user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(rows[0]!.tokenHash).not.toBe(account.refreshToken);
    // 30 days by default.
    const days = (rows[0]!.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThanOrEqual(30);
  });

  it("trims and lower-cases the email, and trims the name", async () => {
    const res = await post("/auth/register")
      .send({ email: "  Mixed.Case@Example.COM ", password: TEST_PASSWORD, name: "  Casey  " })
      .expect(201);
    expect(res.body.user).toMatchObject({ email: "mixed.case@example.com", name: "Casey" });
  });

  it("does not trim the password", async () => {
    const password = "  spaces around me  ";
    const email = "spacey@example.com";
    await post("/auth/register").send({ email, password, name: "Spacey" }).expect(201);
    await post("/auth/login").send({ email, password }).expect(200);
    await post("/auth/login").send({ email, password: password.trim() }).expect(401);
  });

  it("keeps the phone as typed", async () => {
    const res = await post("/auth/register")
      .send({
        email: "phone1@example.com",
        password: TEST_PASSWORD,
        name: "P",
        phone: " (555) 010-0142 ",
      })
      .expect(201);
    expect(res.body.user.phone).toBe("(555) 010-0142");
  });

  it("rejects an email that is already registered, ignoring case", async () => {
    const first = await t.signUp({ email: "taken@example.com" });
    const res = await post("/auth/register")
      .send({ email: "TAKEN@example.com", password: TEST_PASSWORD, name: "Other" })
      .expect(409);
    expect(res.body).toEqual({
      statusCode: 409,
      code: "EMAIL_TAKEN",
      message: "An account with this email already exists.",
    });
    expect(first.email).toBe("taken@example.com");
  });

  it("rejects a phone number that is already used, however it is written", async () => {
    await t.signUp({ phone: "+44 20 7946 0958" });
    const res = await post("/auth/register")
      .send({
        email: "other-phone@example.com",
        password: TEST_PASSWORD,
        name: "X",
        phone: "(442) 079-460958",
      })
      .expect(409);
    expect(res.body.code).toBe("PHONE_TAKEN");
    // The failed sign-up left nothing behind.
    const rows = await t.db.select().from(users).where(eq(users.email, "other-phone@example.com"));
    expect(rows).toHaveLength(0);
  });

  it("answers 422 with every problem listed, one per field", async () => {
    const res = await post("/auth/register").send({}).expect(422);
    expect(res.body).toEqual({
      statusCode: 422,
      code: "VALIDATION_ERROR",
      message: ["Enter a valid email address.", "Enter a password.", "Name can't be empty."],
    });
  });

  it.each([
    ["a bad email", { email: "not-an-email" }, "Enter a valid email address."],
    ["a short password", { password: "short" }, "Password must be at least 8 characters."],
    [
      "a very long password",
      { password: "x".repeat(129) },
      "Password can be at most 128 characters.",
    ],
    ["a blank name", { name: "   " }, "Name can't be empty."],
    ["a long name", { name: "n".repeat(61) }, "Name can be at most 60 characters."],
    ["a short phone", { phone: "12345" }, "Enter a phone number with 7 to 15 digits."],
    [
      "letters in the phone",
      { phone: "555-CALL-NOW" },
      "Enter a phone number with 7 to 15 digits.",
    ],
    ["a non-string name", { name: 42 }, "Name can't be empty."],
  ])("rejects %s", async (_label, patch, message) => {
    const res = await post("/auth/register")
      .send({ email: "ok@example.com", password: TEST_PASSWORD, name: "Ok", ...patch })
      .expect(422);
    expect(res.body).toMatchObject({ code: "VALIDATION_ERROR", message: [message] });
  });

  it("will not let anyone register an address on the guest domain", async () => {
    const res = await post("/auth/register")
      .send({ email: `someone@${GUEST_EMAIL_DOMAIN}`, password: TEST_PASSWORD, name: "Squatter" })
      .expect(422);
    expect(res.body.code).toBe("VALIDATION_ERROR");
  });

  it("ignores fields it does not know, so nobody can set is_bot or the id", async () => {
    const id = newId();
    const res = await post("/auth/register")
      .send({
        email: "sneaky@example.com",
        password: TEST_PASSWORD,
        name: "Sneaky",
        id,
        isBot: true,
        isGuest: true,
        hue: 1,
      })
      .expect(201);
    expect(res.body.user.id).not.toBe(id);
    const [row] = await t.db.select().from(users).where(eq(users.id, res.body.user.id));
    expect(row).toMatchObject({ isBot: false, isGuest: false });
  });

  it("treats a body that is not an object as an empty one", async () => {
    await post("/auth/register").set("Content-Type", "application/json").send("[1,2]").expect(422);
    await post("/auth/register").expect(422);
  });
});

describe("POST /auth/login", () => {
  it("signs in with the right password and sets a new refresh cookie", async () => {
    const account = await t.signUp();
    const res = await post("/auth/login")
      .send({ email: account.email, password: account.password })
      .expect(200);
    expect(res.body.user).toEqual(account.user);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(refreshTokenFrom(res.headers["set-cookie"])).toMatch(/^[\w-]{43}$/u);
    // Each sign-in is its own family, so signing in on a second device leaves the first alone.
    const rows = await t.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, account.user.id));
    expect(new Set(rows.map((r) => r.familyId)).size).toBe(2);
  });

  it("does not care about the case or spaces in the email", async () => {
    const account = await t.signUp();
    await post("/auth/login")
      .send({ email: `  ${account.email.toUpperCase()} `, password: account.password })
      .expect(200);
  });

  it("gives the same answer for a wrong password and an unknown email", async () => {
    const account = await t.signUp();
    const wrongPassword = await post("/auth/login")
      .send({ email: account.email, password: "wrong-password" })
      .expect(401);
    const unknownEmail = await post("/auth/login")
      .send({ email: "nobody@example.com", password: "wrong-password" })
      .expect(401);
    expect(wrongPassword.body).toEqual({
      statusCode: 401,
      code: "INVALID_CREDENTIALS",
      message: "Email or password is incorrect.",
    });
    expect(unknownEmail.body).toEqual(wrongPassword.body);
    expect(refreshTokenFrom(wrongPassword.headers["set-cookie"])).toBeUndefined();
  });

  it("still hashes when the email is unknown, so timing does not give accounts away", async () => {
    const verify = vi.spyOn(t.app.get(PasswordService), "verify");
    await post("/auth/login")
      .send({ email: "ghost@example.com", password: "whatever-it-is" })
      .expect(401);
    expect(verify).toHaveBeenCalledExactlyOnceWith(undefined, "whatever-it-is");
    verify.mockRestore();
  });

  it("never signs in a guest, even with their generated address", async () => {
    const guest = await post("/auth/guest").expect(201);
    const res = await post("/auth/login")
      .send({ email: guest.body.user.email, password: `${TEST_PASSWORD}` })
      .expect(401);
    expect(res.body.code).toBe("INVALID_CREDENTIALS");
  });

  it("never signs in a bot", async () => {
    await t.db
      .insert(users)
      .values({ name: "Bot", hue: 1, isBot: true, email: "bot@dovetalk.invalid" });
    await post("/auth/login")
      .send({ email: "bot@dovetalk.invalid", password: TEST_PASSWORD })
      .expect(401);
  });

  it("answers 422 when the email or password is missing", async () => {
    const res = await post("/auth/login").send({}).expect(422);
    expect(res.body.message).toEqual(["Enter your email.", "Enter your password."]);
  });
});

describe("POST /auth/guest", () => {
  it("creates a guest who is signed in and expires in 24 hours", async () => {
    const res = await post("/auth/guest").expect(201);
    expect(res.body.user.email).toMatch(
      new RegExp(`^guest-[0-9a-f-]{36}@${GUEST_EMAIL_DOMAIN.replaceAll(".", "\\.")}$`, "u"),
    );
    expect(res.body.user.name).toMatch(/^Guest \d{4}$/u);

    const [row] = await t.db.select().from(users).where(eq(users.id, res.body.user.id));
    expect(row).toMatchObject({ isGuest: true, passwordHash: null, isBot: false });
    const hours = (row!.guestExpiresAt!.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);

    await request(t.server)
      .get("/me")
      .set("Authorization", `Bearer ${res.body.accessToken}`)
      .expect(200);
  });

  it("never lets the guest's sign-in outlive the guest", async () => {
    const res = await post("/auth/guest").expect(201);
    const [token] = await t.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, res.body.user.id));
    const [user] = await t.db.select().from(users).where(eq(users.id, res.body.user.id));
    expect(token!.expiresAt.getTime()).toBe(user!.guestExpiresAt!.getTime());
  });

  it("makes a different guest every time", async () => {
    const [a, b] = await Promise.all([post("/auth/guest"), post("/auth/guest")]);
    expect(a.body.user.id).not.toBe(b.body.user.id);
    expect(a.body.user.email).not.toBe(b.body.user.email);
  });

  it("stops serving a guest the moment they expire", async () => {
    const res = await post("/auth/guest").expect(201);
    await t.db
      .update(users)
      .set({ guestExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(users.id, res.body.user.id));
    await request(t.server)
      .get("/me")
      .set("Authorization", `Bearer ${res.body.accessToken}`)
      .expect(401);
  });
});
