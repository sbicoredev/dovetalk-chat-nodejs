import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ShutdownState } from "@dovetalk/core";
import { schema } from "@dovetalk/db";

import { createTestApp, TEST_ORIGIN, type TestApp } from "./support/create-test-app.js";
import { connect, refusal, until } from "./support/sockets.js";

let t: TestApp;
let url: string;

beforeAll(async () => {
  t = await createTestApp();
  url = await t.listen();
});
afterAll(async () => {
  await t.close();
});

/** A token the API would accept, made by hand so a test chooses when it expires. */
const tokenFor = async (
  userId: string,
  expiresInSeconds: number,
  overrides: { secret?: string } = {},
) =>
  new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer("dovetalk-api")
    .setAudience("dovetalk")
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + expiresInSeconds)
    .sign(new TextEncoder().encode(overrides.secret ?? t.env.JWT_SECRET));

describe("who may connect", () => {
  it("lets in somebody with a valid access token", async () => {
    const a = await t.signUp();
    const socket = await connect(url, a);
    expect(socket.socket.connected).toBe(true);
    socket.close();
  });

  it("refuses no token, an empty one and a made-up one with UNAUTHORIZED", async () => {
    const a = await t.signUp();
    expect(await refusal(url, null, { token: null })).toBe("UNAUTHORIZED");
    expect(await refusal(url, "")).toBe("UNAUTHORIZED");
    expect(await refusal(url, "not.a.token")).toBe("UNAUTHORIZED");
    expect(await refusal(url, `${a.accessToken}x`)).toBe("UNAUTHORIZED");
  });

  it("refuses a token signed with another secret and one that has expired", async () => {
    const a = await t.signUp();
    const forged = await tokenFor(a.user.id, 600, {
      secret: "another-secret-another-secret-0123456789",
    });
    expect(await refusal(url, forged)).toBe("UNAUTHORIZED");
    const old = await tokenFor(a.user.id, -60);
    expect(await refusal(url, old)).toBe("UNAUTHORIZED");
    // Inside the few seconds of clock drift that HTTP forgives: a socket would be closed at once, so it is refused.
    const justNow = await tokenFor(a.user.id, -1);
    expect(await refusal(url, justNow)).toBe("UNAUTHORIZED");
  });

  it("refuses somebody whose account is gone, even with a token that is still valid", async () => {
    const a = await t.signUp();
    await t.db.delete(schema.users).where(eq(schema.users.id, a.user.id));
    expect(await refusal(url, a)).toBe("UNAUTHORIZED");
  });

  it("does not speak long-polling: a client that insists on it is refused", async () => {
    const a = await t.signUp();
    expect(await refusal(url, a, { transports: ["polling"] })).not.toBe("CONNECTED");
  });

  it("turns away a page on another origin, and lets in the app's own, the API's host and no origin at all", async () => {
    const a = await t.signUp();
    expect(await refusal(url, a, { origin: "https://evil.example" })).not.toBe("CONNECTED");
    expect(await refusal(url, a, { origin: TEST_ORIGIN })).toBe("CONNECTED");
    expect(await refusal(url, a, { origin: url })).toBe("CONNECTED");
    expect(await refusal(url, a)).toBe("CONNECTED");
  });
});

describe("while an instance is draining", () => {
  it("turns new connections away with SHUTTING_DOWN, so they land on an instance that stays", async () => {
    const a = await t.signUp();
    const leaving = await t.startInstance();
    expect(await refusal(leaving.url, a)).toBe("CONNECTED");
    leaving.app.get(ShutdownState).begin();
    expect(await refusal(leaving.url, a)).toBe("SHUTTING_DOWN");
    // The other instance is unaffected.
    expect(await refusal(url, a)).toBe("CONNECTED");
  });
});

describe("a connection does not outlive its token", () => {
  it("is closed when the token expires, and a reconnect with a fresh token is accepted", async () => {
    const a = await t.signUp();
    const short = await tokenFor(a.user.id, 2);
    const fresh = await tokenFor(a.user.id, 600);
    const socket = await connect(url, short, { tokens: [short, fresh] });
    let closes = 0;
    socket.socket.on("disconnect", () => {
      closes += 1;
    });
    await until(() => closes === 1, "the socket was not closed when its token expired", 6000);
    // Closing the transport (not a clean disconnect) is what makes the client come back by itself.
    await until(
      () => socket.socket.connected,
      "the client did not reconnect with a fresh token",
      6000,
    );
    socket.close();
  });

  it("keeps a client out when all it can offer is the expired token, and tells it why", async () => {
    const a = await t.signUp();
    const short = await tokenFor(a.user.id, 2);
    const socket = await connect(url, short, { tokens: [short] });
    const codes: string[] = [];
    socket.socket.on("connect_error", (error: Error & { data?: { code?: string } }) => {
      codes.push(error.data?.code ?? error.message);
    });
    await until(() => codes.length >= 1, "a stale token was let back in", 6000);
    expect(codes).toEqual(["UNAUTHORIZED"]);
    expect(socket.socket.connected).toBe(false);
    // socket.io does not retry a refused handshake by itself: the app must fetch a token and call connect() again.
    expect(socket.socket.active).toBe(false);
    socket.close();
  });
});
