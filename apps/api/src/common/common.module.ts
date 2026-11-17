import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_PIPE } from "@nestjs/core";
import { ThrottlerModule } from "@nestjs/throttler";
import type { Redis } from "ioredis";

import { REDIS } from "@dovetalk/core";

import { API_ENV, type ApiEnv } from "../config/env.js";
import { AllExceptionsFilter } from "./all-exceptions.filter.js";
import { createThrottlerOptions, RateLimitGuard } from "./rate-limit.js";
import { createValidationPipe } from "./validation.js";

/** Filters, pipes and guards that apply to every route. */
@Module({
  imports: [
    ThrottlerModule.forRootAsync({
      inject: [API_ENV, REDIS],
      useFactory: (env: ApiEnv, redis: Redis) => createThrottlerOptions(env, redis),
    }),
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_PIPE, useFactory: createValidationPipe },
    // Registered before AuthModule's APP_GUARD (imports are resolved first), so limits run first.
    { provide: APP_GUARD, useClass: RateLimitGuard },
  ],
})
export class CommonModule {}
