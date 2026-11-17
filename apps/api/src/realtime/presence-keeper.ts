import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
} from "@nestjs/common";

import { PresenceService, RealtimeEvents } from "@dovetalk/core";

import { API_ENV, type ApiEnv } from "../config/env.js";

/** Connections refreshed in one Redis round trip. */
const BEAT_BATCH = 500;
/** People announced offline per sweep. A bigger backlog is worked through straight away. */
const SWEEP_BATCH = 200;

/**
 * This instance's share of presence: it tells Redis about the connections it holds, keeps them
 * alive with a heartbeat, and looks for people whose time has run out (including those of an
 * instance that crashed) and announces them offline. Every instance runs the sweep, and Redis hands
 * each name to exactly one of them, so nobody is announced twice and nobody is missed while any
 * instance is up.
 */
@Injectable()
export class PresenceKeeper implements OnModuleInit, BeforeApplicationShutdown {
  private readonly logger = new Logger("Presence");
  /** Socket id to user id, for the connections this instance holds. */
  private readonly local = new Map<string, string>();
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;
  private lastFailureLoggedAt = 0;

  constructor(
    @Inject(PresenceService) private readonly presence: PresenceService,
    @Inject(RealtimeEvents) private readonly events: RealtimeEvents,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  onModuleInit(): void {
    this.timers = [
      this.every(this.env.PRESENCE_HEARTBEAT_MS, () => this.beat()),
      this.every(this.env.PRESENCE_SWEEP_MS, () => this.sweep()),
    ];
  }

  /** How many connections this instance holds. */
  get connections(): number {
    return this.local.size;
  }

  /** A connection opened here. */
  async opened(userId: string, socketId: string): Promise<void> {
    this.local.set(socketId, userId);
    if (await this.presence.connect(userId, socketId)) {
      this.events.presenceChanged(userId, true);
    }
  }

  /** A connection closed here. Nobody is announced offline yet: the sweep does that after the debounce. */
  async closed(socketId: string): Promise<void> {
    const userId = this.local.get(socketId);
    if (userId === undefined) {
      return;
    }
    this.local.delete(socketId);
    await this.presence.disconnect([{ userId, socketId }]);
  }

  /**
   * Stops the timers and gives up every connection this instance holds, in one call. The people
   * then go offline after the debounce unless they reconnect elsewhere first, which clients do.
   */
  async shutdown(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
    const beats = [...this.local].map(([socketId, userId]) => ({ socketId, userId }));
    this.local.clear();
    try {
      await this.presence.disconnect(beats);
    } catch (error) {
      this.logger.warn(`Could not release connections on shutdown: ${message(error)}`);
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.shutdown();
  }

  // ---- the two loops -------------------------------------------------------------------

  private async beat(): Promise<void> {
    const beats = [...this.local].map(([socketId, userId]) => ({ socketId, userId }));
    for (let from = 0; from < beats.length; from += BEAT_BATCH) {
      // biome-ignore lint/performance/noAwaitInLoops: batches go one after another so a large instance does not flood Redis at once.
      const back = await this.presence.heartbeat(beats.slice(from, from + BEAT_BATCH));
      // Somebody whose entry was swept while their heartbeat was late is online again.
      for (const userId of back) {
        this.events.presenceChanged(userId, true);
      }
    }
  }

  private async sweep(): Promise<void> {
    let gone: string[];
    do {
      // biome-ignore lint/performance/noAwaitInLoops: a full batch means there may be more, so go again straight away.
      gone = await this.presence.sweep(Date.now(), SWEEP_BATCH);
      for (const userId of gone) {
        this.events.presenceChanged(userId, false);
      }
    } while (gone.length === SWEEP_BATCH);
  }

  /** Runs `work` on a timer, never twice at once, and never lets a failure escape: Redis can be down for a while. */
  private every(ms: number, work: () => Promise<void>): NodeJS.Timeout {
    let running = false;
    const timer = setInterval(() => {
      if (running || this.stopped) {
        return;
      }
      running = true;
      work()
        .catch((error: unknown) => this.logFailure(error))
        .finally(() => {
          running = false;
        });
    }, ms);
    timer.unref();
    return timer;
  }

  /** At most one line every half minute, so an outage does not fill the log. */
  private logFailure(error: unknown): void {
    const now = Date.now();
    if (now - this.lastFailureLoggedAt >= 30_000) {
      this.lastFailureLoggedAt = now;
      this.logger.warn(`Presence update failed: ${message(error)}`);
    }
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
