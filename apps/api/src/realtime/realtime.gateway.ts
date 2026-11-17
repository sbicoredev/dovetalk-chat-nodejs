import { type BeforeApplicationShutdown, Inject, Injectable, Logger } from "@nestjs/common";
import {
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  type OnGatewayInit,
  WebSocketGateway,
} from "@nestjs/websockets";
import type { Server, Socket } from "socket.io";

import { isUuid, RealtimeEvents, ShutdownState, userRoom } from "@dovetalk/core";
import { dovetalkMetrics } from "@dovetalk/telemetry";

import { AccessTokenService } from "../auth/access-token.service.js";
import { AuthUserDirectory } from "../auth/auth-user.directory.js";
import { PresenceKeeper } from "./presence-keeper.js";

/** What the handshake learned about a connection. */
interface SocketData {
  /** When the access token it connected with stops being valid. */
  expiresAt: number;
  userId: string;
}

/** Per-connection state that is not in the socket itself. */
interface Live {
  /** Closes the connection when its token runs out. */
  expiry: NodeJS.Timeout;
  /** Chats this connection has said it is typing in, so that closing it can say it stopped. */
  typing: Set<string>;
  /** When "typing" was last passed on for a chat, for the rate limit. */
  typingSentAt: Map<string, number>;
  userId: string;
}

/** "I am typing" is passed on at most this often per chat. The web app sends it every 3 s. */
const TYPING_MIN_INTERVAL_MS = 1000;
/** Chats remembered per connection for that limit. A person is not typing in more at once. */
const TYPING_CHATS_MAX = 50;

/** A handshake the server turns away. `data.code` reaches the client in `connect_error`. */
const rejection = (code: string) => Object.assign(new Error(code), { data: { code } });

/**
 * The socket.io gateway: who may connect, which room they sit in, and the one thing a client may
 * say (`typing`). Everything a client hears is sent elsewhere: by `RealtimeEvents`, through
 * Redis, to the person's room (`user:{id}`), so which instance holds the connection never matters.
 *
 * Authentication happens in the handshake, before the connection exists, from the access token in
 * `auth.token`. The room is joined there too, so by the time the client is told it is connected
 * this instance is already listening for its events and none can slip past.
 *
 * Handlers are plain `socket.on` listeners rather than `@SubscribeMessage`: the app's global
 * guards, pipes and filters are written for HTTP, and a client message needs different handling
 * anyway (nothing to answer, nothing to throw: a bad one is dropped).
 */
@Injectable()
@WebSocketGateway()
export class RealtimeGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, BeforeApplicationShutdown
{
  private readonly logger = new Logger("Realtime");
  private readonly live = new Map<string, Live>();
  private server: Server | null = null;

  constructor(
    @Inject(AccessTokenService) private readonly tokens: AccessTokenService,
    @Inject(AuthUserDirectory) private readonly directory: AuthUserDirectory,
    @Inject(PresenceKeeper) private readonly keeper: PresenceKeeper,
    @Inject(RealtimeEvents) private readonly events: RealtimeEvents,
    @Inject(ShutdownState) private readonly shutdownState: ShutdownState,
  ) {}

  afterInit(server: Server): void {
    this.server = server;
    server.use((socket, next) => {
      this.authenticate(socket).then(
        () => next(),
        (error: unknown) => {
          if (!(error instanceof Error && "data" in error)) {
            // Not a refusal: something broke. The client sees only a generic failure.
            this.logger.error(
              `Handshake failed: ${error instanceof Error ? error.message : error}`,
            );
            next(rejection("SERVER_ERROR"));
            return;
          }
          next(error);
        },
      );
    });
  }

  /**
   * Who is this, and are they still there? Runs once per connection. A connection is never
   * trusted past the lifetime of its token: see `handleConnection`.
   */
  private async authenticate(socket: Socket): Promise<void> {
    // While shutting down, turn new connections away so they land on an instance that stays.
    if (this.shutdownState.draining) {
      throw rejection("SHUTTING_DOWN");
    }
    const token: unknown = socket.handshake.auth.token;
    if (typeof token !== "string" || token === "") {
      throw rejection("UNAUTHORIZED");
    }
    const verified = await this.tokens.verifyWithExpiry(token);
    // The token check allows a few seconds of clock drift for HTTP. A socket is closed at `exp`, so
    // one let in after it would be closed at once and the client would flap. Refuse it instead, and
    // the client learns it needs a fresh token.
    if (!verified || verified.expiresAt <= Date.now()) {
      throw rejection("UNAUTHORIZED");
    }
    const user = await this.directory.find(verified.userId);
    if (!user) {
      throw rejection("UNAUTHORIZED");
    }
    socket.data = { userId: user.id, expiresAt: verified.expiresAt } satisfies SocketData;
    await socket.join(userRoom(user.id));
  }

  handleConnection(socket: Socket): void {
    const data = socket.data as Partial<SocketData>;
    if (!(data.userId && data.expiresAt)) {
      // Cannot happen through `authenticate`. Never keep a connection nobody vouched for.
      socket.disconnect(true);
      return;
    }

    // A socket is checked once, so it must not outlive the token it was checked with. At expiry
    // the transport is closed (not a clean disconnect, which clients take as "do not come back"):
    // the client reconnects on its own and presents its current token. If it could not refresh the
    // token, that handshake fails and nothing stale is trusted.
    const expiry = setTimeout(
      () => {
        this.logger.debug(`Closing a connection of ${data.userId}: its token expired.`);
        socket.conn.close();
      },
      Math.max(0, data.expiresAt - Date.now()),
    );
    expiry.unref();

    const live: Live = {
      userId: data.userId,
      expiry,
      typing: new Set(),
      typingSentAt: new Map(),
    };
    this.live.set(socket.id, live);
    dovetalkMetrics().wsConnections.add(1);

    socket.on("typing", (payload: unknown) => this.onTyping(live, payload));
    this.keeper.opened(live.userId, socket.id).catch((error: unknown) => {
      this.logger.warn(
        `Could not record a connection: ${error instanceof Error ? error.message : error}`,
      );
    });
  }

  handleDisconnect(socket: Socket): void {
    const live = this.live.get(socket.id);
    if (!live) {
      return;
    }
    this.live.delete(socket.id);
    dovetalkMetrics().wsConnections.add(-1);
    clearTimeout(live.expiry);
    // Somebody who was typing when the connection dropped is not typing any more.
    for (const chatId of live.typing) {
      this.events.typing(chatId, live.userId, false);
    }
    this.keeper.closed(socket.id).catch((error: unknown) => {
      this.logger.warn(
        `Could not release a connection: ${error instanceof Error ? error.message : error}`,
      );
    });
  }

  /**
   * `{ chatId, isTyping }`. Anything else is dropped without a word. Who is in the chat is checked
   * when the event is sent (`RealtimeEvents.typing` does nothing for a non-member), so a client
   * cannot type into somebody else's chat.
   */
  private onTyping(live: Live, payload: unknown): void {
    if (typeof payload !== "object" || payload === null) {
      return;
    }
    dovetalkMetrics().socketEvents.add(1, { event: "typing", direction: "in" });
    const { chatId, isTyping } = payload as Record<string, unknown>;
    if (!isUuid(chatId) || typeof isTyping !== "boolean") {
      return;
    }

    const now = Date.now();
    if (isTyping) {
      const last = live.typingSentAt.get(chatId);
      if (last !== undefined && now - last < TYPING_MIN_INTERVAL_MS) {
        return;
      }
      if (live.typingSentAt.size >= TYPING_CHATS_MAX && !live.typingSentAt.has(chatId)) {
        return;
      }
      live.typingSentAt.set(chatId, now);
      live.typing.add(chatId);
    } else {
      // "Stopped" is always passed on and forgets the chat.
      live.typingSentAt.delete(chatId);
      live.typing.delete(chatId);
    }
    this.events.typing(chatId, live.userId, isTyping);
  }

  /**
   * Gives up this instance's connections cleanly: presence first (so the people are released in one
   * call), then the sockets. Closing the transport, rather than disconnecting, is what makes clients
   * reconnect, and the load balancer is no longer sending new ones here (readiness already failed).
   */
  async beforeApplicationShutdown(): Promise<void> {
    await this.keeper.shutdown();
    for (const live of this.live.values()) {
      clearTimeout(live.expiry);
    }
    // Only this instance's sockets: `disconnectSockets` on the server would, through the adapter, reach every instance's.
    for (const socket of this.server?.sockets.sockets.values() ?? []) {
      socket.conn.close();
    }
    // Their disconnect events may come after the counters are gone, so settle the count here.
    dovetalkMetrics().wsConnections.add(-this.live.size);
    this.live.clear();
  }
}
