import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cid, makeMock } from "@/test/helpers";

// The behaviour every backend shares is in ../conformance/suite.ts. What is left here belongs
// to the mock alone: how it saves data between visits, and when it stays quiet.

/** Keeps what the mock saves in memory, like localStorage does between visits. */
function memoryStorage() {
  let saved: unknown = null;
  let session = false;
  return {
    load: () => saved as never,
    save: (db: unknown) => void (saved = structuredClone(db)),
    clear: () => void (saved = null),
    loadSession: () => session,
    saveSession: (signedIn: boolean) => void (session = signedIn),
  };
}

describe("mock server: persistence and reset", () => {
  it("loads saved data and reset restores the seed", async () => {
    const storage = memoryStorage();
    const first = makeMock({ storage });
    await first.api.me.update({ name: "Changed" });
    first.snapshot();
    storage.save(first.snapshot());
    const second = makeMock({ storage });
    expect((await second.api.me.get()).name).toBe("Changed");
    second.reset();
    expect((await second.api.me.get()).name).toBe("Alex Rivera");
  });
});

describe("mock server: the stand-in for the refresh cookie", () => {
  const demo = { email: "demo@dovetalk.app", password: "dovetalk123" };

  it("keeps somebody signed in across visits, until they sign out", async () => {
    const storage = memoryStorage();
    const first = makeMock({ storage, getToken: () => null });
    await expect(first.api.auth.refresh()).rejects.toMatchObject({ status: 401 });
    await first.api.auth.login(demo);

    // A new page load builds a new mock on the same storage and asks to restore the session.
    const reloaded = makeMock({ storage, getToken: () => null });
    expect((await reloaded.api.auth.refresh()).user.email).toBe(demo.email);

    await reloaded.api.auth.logout();
    const again = makeMock({ storage, getToken: () => null });
    await expect(again.api.auth.refresh()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("holds one account: signing in as the demo account brings the demo data back", async () => {
    const mock = makeMock({ getToken: () => null });
    const created = await mock.api.auth.register({
      email: "sam@example.com",
      password: "correct horse",
      name: "Sam Lee",
    });
    expect(created.user).toMatchObject({ email: "sam@example.com", name: "Sam Lee" });

    expect((await mock.api.auth.login(demo)).user.name).toBe("Alex Rivera");
    await expect(
      mock.api.auth.login({ email: "sam@example.com", password: "correct horse" }),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  it("makes a guest that cannot sign in again", async () => {
    const mock = makeMock({ getToken: () => null });
    const { user } = await mock.api.auth.guest();
    expect(user.email.endsWith("@guest.dovetalk.invalid")).toBe(true);
    await expect(mock.api.auth.login({ email: user.email, password: "" })).rejects.toMatchObject({
      code: "INVALID_CREDENTIALS",
    });
  });
});

describe("mock server: realtime", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("emits nothing while disconnected", async () => {
    const mock = makeMock({ autoReply: true, replyDelaysMs: [10, 20] });
    const handler = vi.fn();
    mock.realtime.on("message:new", handler);
    await mock.api.messages.send("chat-c3", { clientId: cid(), kind: "text", text: "ping" });
    await vi.advanceTimersByTimeAsync(500);
    expect(handler).not.toHaveBeenCalled();
  });
});
