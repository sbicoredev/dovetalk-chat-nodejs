import { Injectable } from "@nestjs/common";
import { HealthIndicatorService } from "@nestjs/terminus";

import { type CheckResult, HealthChecks } from "@dovetalk/core";

/** Turns a core check result into a Terminus indicator result. */
@Injectable()
export class DependencyIndicators {
  constructor(
    private readonly indicators: HealthIndicatorService,
    private readonly checks: HealthChecks,
  ) {}

  private report<K extends string>(key: K, result: CheckResult) {
    const session = this.indicators.check(key);
    return result.ok
      ? session.up({ latencyMs: result.latencyMs })
      : session.down({ error: result.error });
  }

  async database() {
    return this.report("database", await this.checks.database());
  }

  async cache() {
    return this.report("cache", await this.checks.cache());
  }

  /** Down once shutdown has begun, so the load balancer stops sending new traffic. */
  draining() {
    const session = this.indicators.check("shutdown");
    return this.checks.shutdown.draining ? session.down({ draining: true }) : session.up();
  }
}
