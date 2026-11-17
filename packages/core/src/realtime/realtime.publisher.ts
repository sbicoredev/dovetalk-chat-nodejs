import { Inject, Injectable, Logger } from "@nestjs/common";
import { Emitter } from "@socket.io/redis-emitter";
import type { Redis } from "ioredis";

import type { ServerEventName, ServerEvents } from "@dovetalk/contracts";
import { dovetalkMetrics } from "@dovetalk/telemetry";

import { REDIS } from "../tokens.js";
import { userRoom } from "./rooms.js";

/**
 * The one place events leave for sockets, from the API and from the worker alike. It publishes to
 * Redis through `@socket.io/redis-emitter`. The socket.io Redis adapter on every API instance
 * hears it and delivers to whoever is connected there, so neither the worker nor a request
 * handler needs a socket server, and it does not matter which instance holds the connection.
 *
 * Publishing never throws and never rejects. The data is already committed when an event is
 * sent, so a Redis hiccup must not turn a successful request into an error: it is logged and
 * the client catches up when it next loads (it refetches everything after a reconnect).
 */
@Injectable()
export class RealtimePublisher {
  private readonly logger = new Logger("Realtime");
  private readonly emitter: Emitter;
  private readonly pending = new Set<Promise<unknown>>();
  private failures = 0;

  constructor(@Inject(REDIS) redis: Redis) {
    // The emitter calls `publish` and ignores what it returns. With ioredis that is a promise,
    // and a rejected one nobody handles would crash the process, so every publish is caught here
    // and remembered until it settles (`flush` waits for them on shutdown).
    this.emitter = new Emitter({
      publish: (channel: string, message: Uint8Array) => {
        const sent = redis
          .publish(channel, Buffer.from(message))
          .catch((error: unknown) => {
            this.failures += 1;
            this.logger.warn(
              `Could not publish an event: ${error instanceof Error ? error.message : String(error)}`,
            );
          })
          .finally(() => this.pending.delete(sent));
        this.pending.add(sent);
        return sent;
      },
    } as never);
  }

  /** Sends one event to every connection of one person, on every API instance. */
  emitToUser<K extends ServerEventName>(userId: string, event: K, payload: ServerEvents[K]): void {
    try {
      this.emitter.to(userRoom(userId)).emit(event, payload);
      dovetalkMetrics().socketEvents.add(1, { event, direction: "out" });
    } catch (error) {
      this.failures += 1;
      this.logger.error(
        `Could not encode a ${event} event: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * One event to each of several people, with a payload made for each. This is how a chat's
   * members are told: every one of them sees the same thing in their own terms.
   */
  emitToUsers<K extends ServerEventName>(
    userIds: Iterable<string>,
    event: K,
    build: (userId: string) => ServerEvents[K] | null,
  ): void {
    for (const userId of userIds) {
      const payload = build(userId);
      if (payload !== null) {
        this.emitToUser(userId, event, payload);
      }
    }
  }

  /**
   * Runs `emit`, which calls `emitToUser` or `emitToUsers` and nothing asynchronous, and resolves
   * when exactly those publishes have reached Redis. Unlike `flush` it does not wait for other
   * callers' publishes, so the time it takes is this fan-out's own.
   */
  async publishedBy(emit: () => void): Promise<void> {
    const before = new Set(this.pending);
    emit();
    const mine = [...this.pending].filter((sent) => !before.has(sent));
    await Promise.allSettled(mine);
  }

  /** Waits until everything published so far has reached Redis. */
  async flush(): Promise<void> {
    while (this.pending.size > 0) {
      // biome-ignore lint/performance/noAwaitInLoops: more publishes can start while these settle, so it waits again until there are none.
      await Promise.allSettled([...this.pending]);
    }
  }

  /** How many publishes or encodes have failed since the process started. For tests and metrics. */
  get failedCount(): number {
    return this.failures;
  }
}
