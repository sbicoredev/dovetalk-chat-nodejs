import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";

import { ConfigError, installGracefulShutdown, ShutdownState } from "@dovetalk/core";
import { shutdownTelemetry } from "@dovetalk/telemetry";

import { loadWorkerEnv } from "./config/env.js";
import { WorkerModule } from "./worker.module.js";

function readEnv() {
  try {
    return loadWorkerEnv();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const env = readEnv();

// No HTTP server for users: a standalone application context.
const app = await NestFactory.createApplicationContext(WorkerModule.register(env), {
  bufferLogs: true,
});
const logger = app.get(Logger);
// biome-ignore lint/correctness/useHookAtTopLevel: useLogger is a Nest method, not a React hook.
app.useLogger(logger);

installGracefulShutdown({
  app,
  state: app.get(ShutdownState),
  logger,
  afterClose: () => shutdownTelemetry(),
  drainMs: env.SHUTDOWN_DRAIN_MS,
  timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
});

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
  process.exit(1);
});

logger.log("Dovetalk worker started");
