import { and, eq, isNotNull, sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { schema } from "@dovetalk/db";

import { hashToken } from "../src/auth/refresh-token.service.js";
import {
  createTestApp,
  refreshCookie,
  refreshTokenFrom,
  setCookies,
  TEST_ORIGIN,
  type TestApp,
} from "./support/create-test-app.js";

const { users, refreshTokens } = schema;

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const refresh = (token?: string, headers: Record<string, string> = {}) => {
  const req = request(t.server).post("/auth/refresh").set(headers);
  return token ? req.set("Cookie", refreshCookie(token)) : req;
};
const logout = (token?: string, headers: Record<string, string> = {}) => {
  const req = request(t.server).post("/auth/logout").set(headers);
  return token ? req.set("Cookie", refreshCookie(token)) : req;
};

const rowFor = async (token: string) =>
  (
    await t.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(token)))
  )[0]!;

/** Pretends a token was rotated `seconds` ago, so the reuse window can be tested without waiting. */
const rotatedAgo = (token: string, seconds: number) =>
  t.db
    .update(refreshTokens)
    .set({ rotatedAt: sql`now() - make_interval(secs => ${seconds})` })
    .where(eq(refreshTokens.tokenHash, hashToken(token)));

const clearsCookie = (header: string | string[] | undefined) => {
  const line = setCookies(header).find((c) => c.startsWith("dt_refresh="));
  return !!line && /^dt_refresh=;/u.test(line) && /Expires=Thu, 01 Jan 1970/u.test(line);
};

describe("POST /auth/refresh", () => {
  it("trades the cookie for a new access token and a new cookie", async () => {
    const account = await t.signUp();
    const res = await refresh(account.refreshToken).expect(200);

    expect(res.body.user).toEqual(account.user);
    const next = refreshTokenFrom(res.headers["set-cookie"])!;
    expect(next).toMatch(/^[\w-]{43}$/u);
    expect(next).not.toBe(account.refreshToken);
    await request(t.server)
      .get("/me")
      .set("Authorization", `Bearer ${res.body.accessToken}`)
      .expect(200);

    // The old token is marked as used and the new one belongs to the same sign-in.
    const [old, fresh] = [await rowFor(account.refreshToken), await rowFor(next)];
    expect(old.rotatedAt).not.toBeNull();
    expect(fresh.rotatedAt).toBeNull();
    expect(fresh.familyId).toBe(old.familyId);
  });

  it("keeps the chain going: the new token can be refreshed too", async () => {
    const account = await t.signUp();
    let token = account.refreshToken;
    for (let i = 0; i < 3; i += 1) {
      const res = await refresh(token).expect(200);
      token = refreshTokenFrom(res.headers["set-cookie"])!;
    }
    const family = (await rowFor(token)).familyId;
    const rows = await t.db.select().from(refreshTokens).where(eq(refreshTokens.familyId, family));
    expect(rows).toHaveLength(4);
  });

  it("remembers the user agent", async () => {
    const account = await t.signUp();
    const res = await refresh(account.refreshToken, { "User-Agent": "TestBrowser/1.0" }).expect(
      200,
    );
    expect((await rowFor(refreshTokenFrom(res.headers["set-cookie"])!)).userAgent).toBe(
      "TestBrowser/1.0",
    );
  });

  describe("when there is nothing valid to refresh", () => {
    it("answers 401 and clears the cookie when there is no cookie", async () => {
      const res = await refresh().expect(401);
      expect(res.body).toEqual({
        statusCode: 401,
        code: "UNAUTHORIZED",
        message: "Your session has ended. Sign in again.",
      });
      expect(clearsCookie(res.headers["set-cookie"])).toBe(true);
    });

    it.each([
      ["junk", "not-a-token"],
      ["too long", "a".repeat(5000)],
      ["a token nobody was given", "A".repeat(43)],
    ])("answers 401 for %s", async (_label, token) => {
      const res = await refresh(token).expect(401);
      expect(res.body.code).toBe("UNAUTHORIZED");
      expect(clearsCookie(res.headers["set-cookie"])).toBe(true);
    });

    it("answers 401 for an expired token", async () => {
      const account = await t.signUp();
      await t.db
        .update(refreshTokens)
        .set({ expiresAt: sql`now() - interval '1 second'` })
        .where(eq(refreshTokens.tokenHash, hashToken(account.refreshToken)));
      await refresh(account.refreshToken).expect(401);
    });

    it("answers 401 once the person is deleted", async () => {
      const account = await t.signUp();
      await t.db.delete(users).where(eq(users.id, account.user.id));
      await refresh(account.refreshToken).expect(401);
    });
  });

  describe("reuse detection", () => {
    it("lets a token be used again within the grace window, for double requests", async () => {
      const account = await t.signUp();
      const first = await refresh(account.refreshToken).expect(200);
      const second = await refresh(account.refreshToken).expect(200);

      const a = refreshTokenFrom(first.headers["set-cookie"])!;
      const b = refreshTokenFrom(second.headers["set-cookie"])!;
      expect(a).not.toBe(b);
      // Both children are good, so whichever tab's cookie the browser keeps still works.
      await refresh(a).expect(200);
      await refresh(b).expect(200);
    });

    it("survives many requests at once with the same cookie", async () => {
      const account = await t.signUp();
      const results = await Promise.all(
        Array.from({ length: 8 }, () => refresh(account.refreshToken)),
      );
      expect(results.map((r) => r.status)).toEqual(new Array(8).fill(200));
      const tokens = new Set(results.map((r) => refreshTokenFrom(r.headers["set-cookie"])));
      expect(tokens.size).toBe(8);
      const family = (await rowFor(account.refreshToken)).familyId;
      const rows = await t.db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.familyId, family));
      expect(rows).toHaveLength(9);
      expect(rows.filter((r) => r.revokedAt)).toHaveLength(0);
    });

    it("treats an old token used after the window as theft and signs the whole device out", async () => {
      const account = await t.signUp();
      const legit = await refresh(account.refreshToken).expect(200);
      const newest = refreshTokenFrom(legit.headers["set-cookie"])!;
      await rotatedAgo(account.refreshToken, 11);

      // Someone replays the copied, retired token.
      const thief = await refresh(account.refreshToken).expect(401);
      expect(thief.body.code).toBe("UNAUTHORIZED");
      expect(clearsCookie(thief.headers["set-cookie"])).toBe(true);

      // The person's current token is dead too, so they sign in again and the thief is out.
      await refresh(newest).expect(401);
      const family = (await rowFor(newest)).familyId;
      const rows = await t.db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.familyId, family));
      expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
    });

    it("leaves the person's other devices signed in", async () => {
      const phone = await t.signUp();
      const laptop = await request(t.server)
        .post("/auth/login")
        .send({ email: phone.email, password: phone.password })
        .expect(200);
      const laptopToken = refreshTokenFrom(laptop.headers["set-cookie"])!;

      await refresh(phone.refreshToken).expect(200);
      await rotatedAgo(phone.refreshToken, 60);
      await refresh(phone.refreshToken).expect(401); // theft on the phone's chain

      await refresh(laptopToken).expect(200); // the laptop is unaffected
    });

    it("honours the window as configured", async () => {
      const strict = await createTestApp({ REFRESH_REUSE_WINDOW_MS: "0" });
      try {
        const account = await strict.signUp();
        const post = (token: string) =>
          request(strict.server).post("/auth/refresh").set("Cookie", refreshCookie(token));
        await post(account.refreshToken).expect(200);
        await post(account.refreshToken).expect(401);
      } finally {
        await strict.close();
      }
    });
  });

  describe("revoked sign-ins", () => {
    it("answers 401 for a token whose family was revoked", async () => {
      const account = await t.signUp();
      await t.db
        .update(refreshTokens)
        .set({ revokedAt: sql`now()` })
        .where(eq(refreshTokens.userId, account.user.id));
      await refresh(account.refreshToken).expect(401);
    });
  });

  describe("guests", () => {
    it("never extends a guest's sign-in past the guest's own expiry", async () => {
      const guest = await request(t.server).post("/auth/guest").expect(201);
      const res = await refresh(refreshTokenFrom(guest.headers["set-cookie"])).expect(200);
      const [user] = await t.db.select().from(users).where(eq(users.id, guest.body.user.id));
      const next = await rowFor(refreshTokenFrom(res.headers["set-cookie"])!);
      expect(next.expiresAt.getTime()).toBe(user!.guestExpiresAt!.getTime());
    });

    it("refuses an expired guest and revokes their sign-in", async () => {
      const guest = await request(t.server).post("/auth/guest").expect(201);
      const token = refreshTokenFrom(guest.headers["set-cookie"])!;
      await t.db
        .update(users)
        .set({ guestExpiresAt: sql`now() - interval '1 second'` })
        .where(eq(users.id, guest.body.user.id));
      await refresh(token).expect(401);
      const revoked = await t.db
        .select()
        .from(refreshTokens)
        .where(
          and(eq(refreshTokens.userId, guest.body.user.id), isNotNull(refreshTokens.revokedAt)),
        );
      expect(revoked).toHaveLength(1);
    });
  });

  describe("the Origin check", () => {
    it("allows the web app's origin", async () => {
      const account = await t.signUp();
      await refresh(account.refreshToken, { Origin: TEST_ORIGIN }).expect(200);
    });

    it("allows requests with no Origin, such as curl and mobile apps", async () => {
      const account = await t.signUp();
      await refresh(account.refreshToken).expect(200);
    });

    it("refuses another site with 403 and leaves the token alone", async () => {
      const account = await t.signUp();
      const res = await refresh(account.refreshToken, { Origin: "https://evil.example" }).expect(
        403,
      );
      expect(res.body.code).toBe("FORBIDDEN");
      expect(setCookies(res.headers["set-cookie"])).toEqual([]);
      expect((await rowFor(account.refreshToken)).rotatedAt).toBeNull();
      await refresh(account.refreshToken).expect(200);
    });

    it("refuses the string null, which sandboxed pages send", async () => {
      await refresh(undefined, { Origin: "null" }).expect(403);
    });
  });
});

describe("POST /auth/logout", () => {
  it("ends the sign-in, clears the cookie and answers 204", async () => {
    const account = await t.signUp();
    const res = await logout(account.refreshToken).expect(204);
    expect(res.text).toBe("");
    expect(clearsCookie(res.headers["set-cookie"])).toBe(true);
    await refresh(account.refreshToken).expect(401);
  });

  it("revokes the whole chain, including tokens already used", async () => {
    const account = await t.signUp();
    const res = await refresh(account.refreshToken).expect(200);
    const newest = refreshTokenFrom(res.headers["set-cookie"])!;
    await logout(newest).expect(204);

    const family = (await rowFor(newest)).familyId;
    const rows = await t.db.select().from(refreshTokens).where(eq(refreshTokens.familyId, family));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.revokedAt !== null)).toBe(true);
  });

  it("signs out one device and leaves the others", async () => {
    const phone = await t.signUp();
    const laptop = await request(t.server)
      .post("/auth/login")
      .send({ email: phone.email, password: phone.password })
      .expect(200);
    await logout(phone.refreshToken).expect(204);
    await refresh(phone.refreshToken).expect(401);
    await refresh(refreshTokenFrom(laptop.headers["set-cookie"])).expect(200);
  });

  it("needs no access token, so it works after that has expired", async () => {
    const account = await t.signUp();
    await logout(account.refreshToken, { Authorization: "Bearer expired.or.garbage" }).expect(204);
    await refresh(account.refreshToken).expect(401);
  });

  it("is safe to call twice, or with no cookie at all", async () => {
    const account = await t.signUp();
    await logout(account.refreshToken).expect(204);
    await logout(account.refreshToken).expect(204);
    await logout().expect(204);
    await logout("junk").expect(204);
  });

  it("refuses another site and does not sign anyone out", async () => {
    const account = await t.signUp();
    await logout(account.refreshToken, { Origin: "https://evil.example" }).expect(403);
    await refresh(account.refreshToken).expect(200);
  });

  it("leaves the access token working until it expires", async () => {
    const account = await t.signUp();
    await logout(account.refreshToken).expect(204);
    await request(t.server).get("/me").set(account.bearer).expect(200);
  });
});
