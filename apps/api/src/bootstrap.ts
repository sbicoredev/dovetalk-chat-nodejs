import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import helmet from "helmet";
import type { Redis } from "ioredis";
import { Logger } from "nestjs-pino";

import { REDIS } from "@dovetalk/core";

import { AppModule } from "./app.module.js";
import { REFRESH_COOKIE } from "./auth/refresh-cookie.service.js";
import type { ApiEnv } from "./config/env.js";
import { RedisIoAdapter } from "./realtime/redis-io.adapter.js";

/** Builds the app without listening, so tests and main.ts configure it identically. */
export async function createApp(env: ApiEnv): Promise<NestExpressApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.register(env), {
    bufferLogs: true,
  });
  // biome-ignore lint/correctness/useHookAtTopLevel: useLogger is a Nest method, not a React hook.
  app.useLogger(app.get(Logger));
  app.set("trust proxy", env.TRUST_PROXY);

  // The OpenAPI page needs inline scripts, so it gets a looser policy than the JSON API.
  const apiHeaders = helmet();
  const docsHeaders = helmet({ contentSecurityPolicy: false });
  app.use((req: { path: string }, res: unknown, next: () => void) =>
    (req.path.startsWith("/docs") ? docsHeaders : apiHeaders)(req as never, res as never, next),
  );

  // Sockets: WebSocket only, through the Redis adapter, so any instance can reach any connection.
  // biome-ignore lint/correctness/useHookAtTopLevel: a Nest method that happens to start with "use", not a React hook.
  app.useWebSocketAdapter(
    new RedisIoAdapter(app, { redis: app.get<Redis>(REDIS), allowedOrigins: env.CORS_ORIGINS }),
  );

  app.enableCors({
    origin: env.CORS_ORIGINS.length > 0 ? env.CORS_ORIGINS : false,
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Authorization", "Content-Type", "X-Request-Id"],
    exposedHeaders: ["X-Request-Id"],
    maxAge: 600,
  });

  if (env.SWAGGER_ENABLED) {
    const config = new DocumentBuilder()
      .setTitle("Dovetalk API")
      .setDescription("REST API for the Dovetalk chat app. Real-time events use socket.io.")
      .setVersion(env.APP_VERSION)
      .addBearerAuth()
      .addCookieAuth(REFRESH_COOKIE)
      .build();
    SwaggerModule.setup("docs", app, SwaggerModule.createDocument(app, config));
  }

  return app;
}

/** Keep-alive must outlast common load balancer idle timeouts (about 60 s), or they see resets. */
export function tuneServer(app: NestExpressApplication) {
  const server = app.getHttpServer();
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
}
