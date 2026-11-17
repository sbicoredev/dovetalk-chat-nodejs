import { Module } from "@nestjs/common";

import { StatusesController } from "./statuses.controller.js";

/** StatusesService comes from the global CoreModule. */
@Module({ controllers: [StatusesController] })
export class StatusesModule {}
