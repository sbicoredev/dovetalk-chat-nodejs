import type { IncomingMessage } from "node:http";

import type { INestApplicationContext } from "@nestjs/common";
import { Logger } from "@nestjs/common";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import type { Redis } from "ioredis";
import type { Server, ServerOptions } from "socket.io";

export interface RealtimeAdapterOptions {
  /** Web origins that may open a socket from a browser. Empty: same origin only. */
  allowedOrigins: readonly string[];
  /** The connection to copy for the adapter's two subscriber connections. */
  redis: Redis;
}

/** An event is a few hundred bytes. A client that sends more than this is not ours. */
export const MAX_SOCKET_PAYLOAD_BYTES = 16 * 1024;

/**
 * The socket.io server for every gateway, set up the same way in every instance:
 *
 * - **WebSocket only.** No long-polling, so a connection is one TCP stream for its whole life and
 *   the load balancer needs no sticky sessions (a polling client has to reach the same instance on
 *   every request). Browsers have spoken WebSocket for a decade.
 * - **The Redis adapter**, which is what makes `emitToUser` reach a person whichever instance
 *   holds their connection, and what the worker's emitter publishes into. It gets its own pair of
 *   connections, because a connection in subscriber mode can do nothing else.
 * - **Origin check.** Browsers always send `Origin` on a WebSocket handshake, so a page on some
 *   other site is turned away. Auth is by token in the handshake, not by cookie, so a hostile page
 *   could not use somebody's session anyway: this only keeps strangers' pages out. Clients that
 *   send no `Origin` (the load tests, a phone app) are let through to the token check.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly socketLog = new Logger("SocketAdapter");
  private connections: Redis[] = [];

  constructor(
    app: INestApplicationContext,
    private readonly settings: RealtimeAdapterOptions,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const settings: Partial<ServerOptions> = {
      ...options,
      transports: ["websocket"],
      serveClient: false,
      maxHttpBufferSize: MAX_SOCKET_PAYLOAD_BYTES,
      perMessageDeflate: false,
      allowRequest: (request, callback) => {
        callback(null, this.originAllowed(request));
      },
    };
    const server = super.createIOServer(port, settings as ServerOptions) as Server;

    const publisher = this.settings.redis.duplicate();
    const subscriber = this.settings.redis.duplicate();
    for (const connection of [publisher, subscriber]) {
      connection.on("error", (error) => this.socketLog.error(error.message));
    }
    this.connections.push(publisher, subscriber);
    server.adapter(createAdapter(publisher, subscriber));
    return server;
  }

  override async close(server: Server): Promise<void> {
    try {
      await super.close(server);
    } finally {
      const { connections } = this;
      this.connections = [];
      await Promise.allSettled(
        connections.map((connection) => connection.quit().catch(() => connection.disconnect())),
      );
    }
  }

  private originAllowed(request: IncomingMessage): boolean {
    const { origin } = request.headers;
    if (!origin) {
      return true;
    }
    if (this.settings.allowedOrigins.includes(origin)) {
      return true;
    }
    try {
      // The page and the API on one host need no configuration.
      return new URL(origin).host === request.headers.host;
    } catch {
      return false;
    }
  }
}
