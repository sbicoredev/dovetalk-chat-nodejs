import { Module } from "@nestjs/common";

import { ProfileService } from "./profile.service.js";
import { UsersService } from "./users.service.js";

@Module({ providers: [UsersService, ProfileService], exports: [UsersService, ProfileService] })
export class UsersModule {}
