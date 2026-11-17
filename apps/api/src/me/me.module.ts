import { Module } from "@nestjs/common";

import { UsersModule } from "../users/users.module.js";
import { MeController } from "./me.controller.js";

@Module({ imports: [UsersModule], controllers: [MeController] })
export class MeModule {}
