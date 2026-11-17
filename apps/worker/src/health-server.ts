import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";

import { HealthChecks } from "@dovetalk/core";

import { WORKER_ENV, type WorkerEnv } from "./config/env.js";

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

/**
 * Answers /health/live and /health/ready so the hosting platform can supervise the worker.
 * It is the only thing listening; the worker takes no requests from users.
 */
@Injectable()
export class HealthServer implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(HealthServer.name);
  private readonly server: Server;

  constructor(
    private readonly checks: HealthChecks,
    @Inject(WORKER_ENV) private readonly env: WorkerEnv,
  ) {
    this.server = createServer((req, res) => {
      const [path] = (req.url ?? "").split("?");
      if (req.method !== "GET") {
        return json(res, 405, { status: "error" });
      }
      if (path === "/health/live") {
        return json(res, 200, {
          status: "ok",
          version: this.env.APP_VERSION,
          uptimeSeconds: Math.round(process.uptime()),
        });
      }
      if (path === "/health/ready") {
        this.checks.ready().then(
          (ready) =>
            json(res, ready.ok ? 200 : 503, { status: ready.ok ? "ok" : "error", ...ready }),
          () => json(res, 503, { status: "error" }),
        );
        return;
      }
      json(res, 404, { status: "error" });
    });
  }

  async onModuleInit() {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.env.WORKER_HEALTH_PORT, this.env.WORKER_HEALTH_HOST, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.logger.log(`Health endpoint on port ${this.port}`);
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  async onApplicationShutdown() {
    if (!this.server.listening) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }
}
