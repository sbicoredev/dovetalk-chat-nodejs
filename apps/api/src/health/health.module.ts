import { Module } from "@nestjs/common";
import { TerminusModule } from "@nestjs/terminus";

import { HealthController } from "./health.controller.js";
import { DependencyIndicators } from "./indicators.js";

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [DependencyIndicators],
})
export class HealthModule {}
