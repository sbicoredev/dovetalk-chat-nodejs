import { io, type Socket } from "socket.io-client";

import type { RealtimeClient } from "./api";
import type { RefreshOutcome } from "./http";
import {
  type ConnectionState,
  SERVER_EVENT_NAMES,
  type ServerEventName,
  type ServerEvents,
} from "./types";

export interface SocketOptions {
  /** Read at every connection attempt, so a token renewed since the last one is the one sent. */
  getToken: () => string | null;
  /** Socket.io path if your gateway does not use the default "/socket.io". */
  path?: string;
  /**
   * Called when the server turns a handshake away with `UNAUTHORIZED` (the token is missing,
   * expired or not valid). socket.io does not retry a refused handshake, so on "refreshed" the
   * client connects again by itself, and on "signed-out" it stays out.
   */
  refreshToken?: () => Promise<RefreshOutcome>;
  /** For example "http://localhost:3001". Namespaces can be added to the path. */
  url: string;
}

/** The first wait before trying again after a refused handshake, and the longest one. */
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 10_000;

/** What the gateway puts on a refused handshake: `error.data.code` (docs/API.md, "Connecting"). */
function refusalCode(error: unknown): string | null {
  const data = (error as { data?: { code?: unknown } } | null)?.data;
  return typeof data?.code === "string" ? data.code : null;
}

/**
 * Connects to the API's socket.io gateway. The access token is sent in the handshake as
 * `auth.token`, and the gateway puts each person in their own room and emits the events listed
 * in `ServerEvents`.
 *
 * Staying connected: when the connection drops, socket.io reconnects by itself and the handshake
 * carries whatever token is current. When the handshake is refused it does not, so this client
 * does: after a refresh when the token was the problem, and after a wait (1 s, doubling to 10 s)
 * when the instance was shutting down or could not check the token.
 */
export function createSocketRealtime(options: SocketOptions): RealtimeClient {
  let socket: Socket | null = null;
  const handlers = new Map<string, Set<(payload: never) => void>>();
  const connectionHandlers = new Set<(state: ConnectionState) => void>();

  const setState = (state: ConnectionState) => connectionHandlers.forEach((h) => h(state));

  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let retries = 0;
  const cancelRetry = () => {
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  /** Connects `target` again, unless it has been replaced or closed in the meantime. */
  const reconnect = (target: Socket) => {
    if (socket === target && !target.connected) {
      setState("connecting");
      target.connect();
    }
  };

  const retryLater = (target: Socket) => {
    cancelRetry();
    const wait = Math.min(RETRY_BASE_MS * 2 ** retries, RETRY_MAX_MS);
    retries += 1;
    retryTimer = setTimeout(() => reconnect(target), wait * (0.75 + Math.random() * 0.5));
  };

  /** socket.io gave up on this socket (a refused handshake, or the server closed it for good). */
  const recover = async (target: Socket, code: string | null) => {
    if (code === "UNAUTHORIZED") {
      if (!options.refreshToken) {
        return;
      }
      const outcome = await options.refreshToken();
      if (socket !== target || outcome === "signed-out") {
        return; // Closed meanwhile, or nobody is signed in: a stale socket is never trusted.
      }
      if (outcome === "refreshed") {
        retries = 0;
        reconnect(target);
        return;
      }
    }
    retryLater(target);
  };

  return {
    connect() {
      if (socket) {
        return;
      }
      setState("connecting");
      const next = io(options.url, {
        path: options.path,
        transports: ["websocket"],
        auth: (cb) => cb({ token: options.getToken() }),
        reconnectionDelayMax: 10_000,
      });
      next.on("connect", () => {
        retries = 0;
        setState("connected");
      });
      next.on("disconnect", () => {
        setState("disconnected");
        // "io server disconnect" is the one close that socket.io does not undo by itself.
        if (socket === next && !next.active) {
          void recover(next, null);
        }
      });
      next.on("connect_error", (error) => {
        setState("disconnected");
        // While `active` is true socket.io is retrying (the server was unreachable).
        if (socket === next && !next.active) {
          void recover(next, refusalCode(error));
        }
      });
      next.io.on("reconnect_attempt", () => setState("connecting"));
      for (const name of SERVER_EVENT_NAMES) {
        next.on(name, (payload: unknown) => {
          handlers.get(name)?.forEach((h) => h(payload as never));
        });
      }
      socket = next;
    },
    disconnect() {
      cancelRetry();
      retries = 0;
      const closing = socket;
      socket = null; // First, so the close below is not mistaken for a drop to recover from.
      closing?.disconnect();
      setState("disconnected");
    },
    on<K extends ServerEventName>(event: K, handler: (payload: ServerEvents[K]) => void) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler as (payload: never) => void);
      handlers.set(event, set);
      return () => {
        set.delete(handler as (payload: never) => void);
      };
    },
    onConnection(handler) {
      connectionHandlers.add(handler);
      return () => {
        connectionHandlers.delete(handler);
      };
    },
    emit(event, payload) {
      socket?.emit(event, payload);
    },
  };
}
