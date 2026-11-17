import { Module } from "@nestjs/common";

import { UploadsController } from "./uploads.controller.js";

/** UploadsService comes from the global CoreModule. */
@Module({ controllers: [UploadsController] })
export class UploadsModule {}
