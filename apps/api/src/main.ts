import { Logger } from "nestjs-pino";

import { ConfigError, installGracefulShutdown, ShutdownState } from "@dovetalk/core";
import { shutdownTelemetry } from "@dovetalk/telemetry";

import { createApp, tuneServer } from "./bootstrap.js";
import { loadApiEnv } from "./config/env.js";

function readEnv() {
  try {
    return loadApiEnv();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const env = readEnv();

const app = await createApp(env);
const logger = app.get(Logger);
tuneServer(app);

installGracefulShutdown({
  app,
  state: app.get(ShutdownState),
  logger,
  afterClose: () => shutdownTelemetry(),
  drainMs: env.SHUTDOWN_DRAIN_MS,
  timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
});

// A rejection nobody handled means the process is in an unknown state. Log it and let the
// supervisor start a clean one.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection");
  process.exit(1);
});

await app.listen(env.PORT, env.HOST);
logger.log(`Dovetalk API listening on http://${env.HOST}:${env.PORT}`);
