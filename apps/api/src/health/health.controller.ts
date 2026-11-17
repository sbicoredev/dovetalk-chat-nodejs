import { Controller, Get, Inject, UseFilters } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import { HealthCheck, HealthCheckService } from "@nestjs/terminus";

import { Public, RateLimit } from "../common/decorators.js";
import { API_ENV, type ApiEnv } from "../config/env.js";
import { DependencyIndicators } from "./indicators.js";
import { ReadinessFilter } from "./readiness.filter.js";

@ApiTags("health")
@Public()
// Probes run every few seconds from the platform. They are never rate limited.
@RateLimit("none")
@Controller("health")
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicators: DependencyIndicators,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  @Get("live")
  @ApiOperation({ summary: "Liveness: the process is running. Never checks dependencies." })
  @ApiOkResponse({ description: "The process is up." })
  live() {
    return {
      status: "ok",
      version: this.env.APP_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
    };
  }

  @Get("ready")
  @UseFilters(ReadinessFilter)
  @HealthCheck()
  @ApiOperation({ summary: "Readiness: Postgres and Redis answer, and we are not shutting down." })
  @ApiOkResponse({ description: "Ready for traffic." })
  ready() {
    return this.health.check([
      () => this.indicators.draining(),
      () => this.indicators.database(),
      () => this.indicators.cache(),
    ]);
  }
}
