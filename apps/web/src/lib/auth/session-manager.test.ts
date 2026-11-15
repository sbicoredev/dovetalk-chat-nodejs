import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Api } from "@/lib/api/api";
import { ApiError } from "@/lib/api/errors";
import type { AuthResult, MeDto } from "@/lib/api/types";
import { useSession } from "@/lib/stores/session";

import { createSessionManager, tokenExpiry } from "./session-manager";

const user = { id: "u1", name: "Sam" } as MeDto;

/** A JWT-shaped token that expires at `exp` (epoch seconds). Nothing checks the signature here. */
function jwt(exp: number) {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/[=]+$/u, "");
  return `${encode({ alg: "none" })}.${encode({ sub: "u1", exp })}.sig`;
}

const unauthorized = () => new ApiError(401, "UNAUTHORIZED", "No session.");

function setup(refresh: () => Promise<AuthResult>, now = () => Date.now()) {
  const api = { auth: { refresh: vi.fn(refresh) } } as unknown as Api;
  const manager = createSessionManager({ getApi: () => api, now });
  return { manager, refresh: api.auth.refresh as ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-15T12:00:00Z"));
  useSession.setState({ token: null, hydrated: false, restoreError: null });
});
afterEach(() => vi.useRealTimers());

describe("tokenExpiry", () => {
  it("reads the exp claim of a JWT in milliseconds", () => {
    expect(tokenExpiry(jwt(1_800_000_000))).toBe(1_800_000_000_000);
  });

  it("returns null for anything that is not a JWT, such as the mock's tokens", () => {
    expect(tokenExpiry("mock.u_me.1794755211383")).toBeNull();
    expect(tokenExpiry("garbage")).toBeNull();
    expect(tokenExpiry("")).toBeNull();
  });
});

describe("session manager: restoring a sign-in", () => {
  it("signs in from the refresh cookie and tells listeners who it is", async () => {
    const { manager } = setup(async () => ({ accessToken: "tok", user }));
    const heard = vi.fn();
    manager.onRestored(heard);
    await manager.restore();
    expect(useSession.getState()).toMatchObject({
      token: "tok",
      hydrated: true,
      restoreError: null,
    });
    expect(heard).toHaveBeenCalledWith(user);
    manager.dispose();
  });

  it("ends signed out, and loaded, when there is no cookie", async () => {
    const { manager } = setup(async () => Promise.reject(unauthorized()));
    await manager.restore();
    expect(useSession.getState()).toMatchObject({
      token: null,
      hydrated: true,
      restoreError: null,
    });
    manager.dispose();
  });

  it("treats a refused origin (403) as signed out too", async () => {
    const { manager } = setup(async () => Promise.reject(new ApiError(403, "FORBIDDEN", "No.")));
    await manager.restore();
    expect(useSession.getState()).toMatchObject({ token: null, hydrated: true });
    manager.dispose();
  });

  it("keeps the question open when the server cannot be reached", async () => {
    const { manager } = setup(async () =>
      Promise.reject(new ApiError(0, "NETWORK_ERROR", "Can't reach the server.")),
    );
    await manager.restore();
    const state = useSession.getState();
    expect(state.token).toBeNull();
    expect(state.hydrated).toBe(true);
    expect(state.restoreError).toMatch(/reach the server/u);
    manager.dispose();
  });

  it("can try again after a failed restore", async () => {
    let up = false;
    const { manager } = setup(async () =>
      up ? { accessToken: "tok", user } : Promise.reject(new ApiError(0, "NETWORK_ERROR", "Down.")),
    );
    await manager.restore();
    expect(useSession.getState().restoreError).not.toBeNull();
    up = true;
    await manager.restore();
    expect(useSession.getState()).toMatchObject({ token: "tok", restoreError: null });
    manager.dispose();
  });

  it("removes the access token that earlier versions left in localStorage", async () => {
    localStorage.setItem("dovetalk:token", "old-token");
    const { manager } = setup(async () => Promise.reject(unauthorized()));
    await manager.restore();
    expect(localStorage.getItem("dovetalk:token")).toBeNull();
    manager.dispose();
  });
});

describe("session manager: refresh", () => {
  it("shares one call between everything that asks at once", async () => {
    let finish: (r: AuthResult) => void = () => undefined;
    const { manager, refresh } = setup(() => new Promise((resolve) => (finish = resolve)));
    useSession.getState().setToken("old");
    const all = [manager.refresh(), manager.refresh(), manager.refresh()];
    finish({ accessToken: "new", user });
    expect(await Promise.all(all)).toEqual(["refreshed", "refreshed", "refreshed"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(useSession.getState().token).toBe("new");
    manager.dispose();
  });

  it("does not announce the user when it only renews a token", async () => {
    const { manager } = setup(async () => ({ accessToken: "new", user }));
    const heard = vi.fn();
    manager.onRestored(heard);
    useSession.getState().setToken("old");
    await manager.refresh();
    expect(heard).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("signs out when the cookie is refused, and keeps the person in when it cannot ask", async () => {
    const down = setup(async () => Promise.reject(new ApiError(0, "NETWORK_ERROR", "Down.")));
    useSession.getState().setToken("old");
    expect(await down.manager.refresh()).toBe("unavailable");
    expect(useSession.getState().token).toBe("old");
    down.manager.dispose();

    const refused = setup(async () => Promise.reject(unauthorized()));
    expect(await refused.manager.refresh()).toBe("signed-out");
    expect(useSession.getState().token).toBeNull();
    refused.manager.dispose();
  });

  it("asks again for a new token once the first call is done", async () => {
    const { manager, refresh } = setup(async () => ({ accessToken: "new", user }));
    await manager.refresh();
    await manager.refresh();
    expect(refresh).toHaveBeenCalledTimes(2);
    manager.dispose();
  });
});

describe("session manager: renewing before the token expires", () => {
  const nowSeconds = () => Math.floor(Date.now() / 1000);

  it("refreshes a minute before the token runs out, then schedules the next", async () => {
    let calls = 0;
    const { manager, refresh } = setup(async () => {
      calls += 1;
      return { accessToken: jwt(nowSeconds() + 900), user };
    });
    useSession.getState().setToken(jwt(nowSeconds() + 900));

    await vi.advanceTimersByTimeAsync(13 * 60_000);
    expect(refresh).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000 + 1000);
    expect(calls).toBe(1);

    // The new token has its own 15 minutes.
    await vi.advanceTimersByTimeAsync(14 * 60_000 + 2000);
    expect(calls).toBe(2);
    manager.dispose();
  });

  it("tries again in 30 seconds when the server was unreachable", async () => {
    let up = false;
    const { manager, refresh } = setup(async () =>
      up
        ? { accessToken: jwt(nowSeconds() + 900), user }
        : Promise.reject(new ApiError(0, "NETWORK_ERROR", "Down.")),
    );
    useSession.getState().setToken(jwt(nowSeconds() + 30));
    await vi.advanceTimersByTimeAsync(6000);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(useSession.getState().token).not.toBeNull();

    up = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(tokenExpiry(useSession.getState().token ?? "")).toBeGreaterThan(Date.now() + 800_000);
    manager.dispose();
  });

  it("stops when the person signs out", async () => {
    const { manager, refresh } = setup(async () => ({ accessToken: "x", user }));
    useSession.getState().setToken(jwt(nowSeconds() + 900));
    useSession.getState().clear();
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(refresh).not.toHaveBeenCalled();
    manager.dispose();
  });

  it("leaves tokens that do not expire alone", async () => {
    const { manager, refresh } = setup(async () => ({ accessToken: "x", user }));
    useSession.getState().setToken("mock.u_me.1");
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(refresh).not.toHaveBeenCalled();
    manager.dispose();
  });
});
