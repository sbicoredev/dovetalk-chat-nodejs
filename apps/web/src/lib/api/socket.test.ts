import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RefreshOutcome } from "./http";
import { createSocketRealtime } from "./socket";

/** Just enough of a socket.io client to drive the reconnect logic from a test. */
class FakeSocket {
  active = true;
  connected = false;
  readonly connect = vi.fn(() => {
    this.active = true;
  });
  readonly disconnectCalls = vi.fn();
  readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  readonly io = { on: vi.fn() };
  readonly emit = vi.fn();

  on(event: string, handler: (...args: unknown[]) => void) {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
  disconnect() {
    this.connected = false;
    this.disconnectCalls();
    this.fire("disconnect", "io client disconnect");
    return this;
  }
  fire(event: string, ...args: unknown[]) {
    this.handlers.get(event)?.forEach((handler) => handler(...args));
  }
  /** A handshake the server refused: socket.io gives up on it (`active` is false). */
  refuse(code: string | null) {
    this.active = false;
    this.fire(
      "connect_error",
      Object.assign(new Error(code ?? "nope"), code ? { data: { code } } : {}),
    );
  }
}

const created: Array<{
  socket: FakeSocket;
  options: { auth: (cb: (a: unknown) => void) => void };
}> = [];

vi.mock("socket.io-client", () => ({
  io: (_url: string, options: { auth: (cb: (a: unknown) => void) => void }) => {
    const socket = new FakeSocket();
    created.push({ socket, options });
    return socket;
  },
}));

function setup(outcome: RefreshOutcome | null = "refreshed") {
  created.length = 0;
  let token: string | null = "old";
  const refreshToken = outcome
    ? vi.fn(async () => {
        if (outcome === "refreshed") {
          token = "renewed";
        }
        return outcome;
      })
    : undefined;
  const realtime = createSocketRealtime({
    url: "http://api.test",
    getToken: () => token,
    refreshToken,
  });
  const states: string[] = [];
  realtime.onConnection((state) => states.push(state));
  realtime.connect();
  const { socket, options } = created[0]!;
  return { realtime, socket, options, refreshToken, states, setToken: (t: string) => (token = t) };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("socket client: staying connected", () => {
  it("sends the current token at every attempt, not the one from the first", () => {
    const { options, setToken } = setup();
    const seen: unknown[] = [];
    options.auth((auth) => seen.push(auth));
    setToken("newer");
    options.auth((auth) => seen.push(auth));
    expect(seen).toEqual([{ token: "old" }, { token: "newer" }]);
  });

  it("refreshes after an UNAUTHORIZED handshake, then connects again", async () => {
    const { socket, refreshToken, states } = setup("refreshed");
    socket.refuse("UNAUTHORIZED");
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(states.at(-1)).toBe("connecting");
  });

  it("stays out when the session cannot be renewed", async () => {
    const { socket, refreshToken, states } = setup("signed-out");
    socket.refuse("UNAUTHORIZED");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(socket.connect).not.toHaveBeenCalled();
    expect(states.at(-1)).toBe("disconnected");
  });

  it("waits and tries again when the server could not be reached to renew", async () => {
    const { socket } = setup("unavailable");
    socket.refuse("UNAUTHORIZED");
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it("does not guess without a way to renew: an UNAUTHORIZED handshake ends it", async () => {
    const { socket } = setup(null);
    socket.refuse("UNAUTHORIZED");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it.each(["SHUTTING_DOWN", "SERVER_ERROR"])("backs off and retries after %s", async (code) => {
    const { socket, refreshToken } = setup();
    socket.refuse(code);
    await vi.advanceTimersByTimeAsync(500);
    expect(socket.connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(refreshToken).not.toHaveBeenCalled();

    // Refused again: the wait doubles.
    socket.refuse(code);
    await vi.advanceTimersByTimeAsync(1000);
    expect(socket.connect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2500);
    expect(socket.connect).toHaveBeenCalledTimes(2);
  });

  it("leaves a plain network failure to socket.io, which is already retrying", async () => {
    const { socket, refreshToken } = setup();
    socket.fire("connect_error", new Error("xhr poll error")); // `active` stays true
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.connect).not.toHaveBeenCalled();
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("reconnects after the server closes it for good", async () => {
    const { socket } = setup();
    socket.active = false;
    socket.fire("disconnect", "io server disconnect");
    await vi.advanceTimersByTimeAsync(2000);
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it("does nothing after disconnect(), even with a retry waiting", async () => {
    const { realtime, socket } = setup();
    socket.refuse("SHUTTING_DOWN");
    realtime.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it("forgets the wait once connected", async () => {
    const { socket } = setup();
    socket.refuse("SHUTTING_DOWN");
    await vi.advanceTimersByTimeAsync(1500);
    socket.connected = true;
    socket.fire("connect");

    socket.connected = false;
    socket.refuse("SHUTTING_DOWN");
    await vi.advanceTimersByTimeAsync(1300);
    expect(socket.connect).toHaveBeenCalledTimes(2);
  });
});
