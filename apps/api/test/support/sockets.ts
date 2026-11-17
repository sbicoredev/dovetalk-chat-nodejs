import { io, type Socket } from "socket.io-client";

import type { ServerEventName, ServerEvents } from "@dovetalk/contracts";

import type { TestAccount } from "./create-test-app.js";

export interface Heard {
  event: string;
  payload: unknown;
}

/** A connected test client that remembers everything it was told. */
export interface TestSocket {
  /** Everything heard, in order. */
  all: Heard[];
  close: () => void;
  /** Every payload of one event, in order. */
  heard: <K extends ServerEventName>(event: K) => ServerEvents[K][];
  /** Waits for an event (matching `where`, if given) that has not been seen before this call. */
  next: <K extends ServerEventName>(
    event: K,
    where?: (payload: ServerEvents[K]) => boolean,
    timeoutMs?: number,
  ) => Promise<ServerEvents[K]>;
  socket: Socket;
  /**
   * Waits for an event, matching `where` if given. Looks at everything heard so far too, so it
   * does not matter whether the event came before or after this call.
   */
  waitFor: <K extends ServerEventName>(
    event: K,
    where?: (payload: ServerEvents[K]) => boolean,
    timeoutMs?: number,
  ) => Promise<ServerEvents[K]>;
}

const TIMEOUT_MS = 5000;

const wrap = (socket: Socket): TestSocket => {
  const all: Heard[] = [];
  socket.onAny((event: string, payload: unknown) => all.push({ event, payload }));
  const heard = <K extends ServerEventName>(event: K) =>
    all.filter((h) => h.event === event).map((h) => h.payload as ServerEvents[K]);

  return {
    socket,
    all,
    waitFor: async <K extends ServerEventName>(
      event: K,
      where: (payload: ServerEvents[K]) => boolean = () => true,
      timeoutMs = TIMEOUT_MS,
    ) => {
      let found: ServerEvents[K] | undefined;
      await until(
        () => {
          found = heard(event).find(where);
          return found !== undefined;
        },
        `No ${event} arrived within ${timeoutMs} ms. Heard: ${all.map((h) => h.event).join(", ") || "nothing"}.`,
        timeoutMs,
      );
      return found as ServerEvents[K];
    },
    close: () => socket.close(),
    heard,
    next: <K extends ServerEventName>(
      event: K,
      where: (payload: ServerEvents[K]) => boolean = () => true,
      timeoutMs = TIMEOUT_MS,
    ) =>
      new Promise<ServerEvents[K]>((resolve, reject) => {
        const timer = setTimeout(() => {
          socket.off(event, listener as never);
          reject(
            new Error(
              `No ${event} arrived within ${timeoutMs} ms. Heard: ${all.map((h) => h.event).join(", ") || "nothing"}.`,
            ),
          );
        }, timeoutMs);
        const listener = (payload: ServerEvents[K]) => {
          if (where(payload)) {
            clearTimeout(timer);
            socket.off(event, listener as never);
            resolve(payload);
          }
        };
        socket.on(event, listener as never);
      }),
  };
};

export interface ConnectOptions {
  /** Sent as the Origin header, the way a browser would. */
  origin?: string;
  /** Skip the token entirely. */
  token?: string | null;
  /** Tokens to present, one per attempt; the last one repeats. Turns reconnection on. */
  tokens?: string[];
  transports?: ("websocket" | "polling")[];
}

/** Connects and resolves once the server has accepted the connection. Rejects with the server's reason. */
export function connect(
  url: string,
  who: TestAccount | string | null,
  options: ConnectOptions = {},
): Promise<TestSocket> {
  const token = typeof who === "string" ? who : (who?.accessToken ?? null);
  const attempts = options.tokens ?? [];
  let attempt = 0;
  const socket = io(url, {
    transports: options.transports ?? ["websocket"],
    forceNew: true,
    reconnection: attempts.length > 0,
    reconnectionDelay: 50,
    reconnectionDelayMax: 100,
    auth: (give) => {
      if (attempts.length > 0) {
        give({ token: attempts[Math.min(attempt, attempts.length - 1)] });
        attempt += 1;
        return;
      }
      give(options.token === null ? {} : { token: options.token ?? token });
    },
    ...(options.origin ? { extraHeaders: { Origin: options.origin } } : {}),
  });
  const wrapped = wrap(socket);
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve(wrapped));
    socket.once("connect_error", (error: Error & { data?: { code?: string } }) => {
      socket.close();
      reject(Object.assign(error, { code: error.data?.code ?? error.message }));
    });
  });
}

/** What the server said when it refused: the code, or `"CONNECTED"` if it let the socket in. */
export async function refusal(
  url: string,
  who: TestAccount | string | null,
  options: ConnectOptions = {},
): Promise<string> {
  try {
    (await connect(url, who, options)).close();
    return "CONNECTED";
  } catch (error) {
    return (error as { code: string }).code;
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until `check` is true, or fails with `message`. */
export async function until(
  check: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    await sleep(20);
  }
}
