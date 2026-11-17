import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { UsersModule } from "../users/users.module.js";
import { AccessTokenService } from "./access-token.service.js";
import { AllowedOriginGuard } from "./allowed-origin.guard.js";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { AuthUserDirectory } from "./auth-user.directory.js";
import { JwtAuthGuard } from "./jwt-auth.guard.js";
import { PasswordService } from "./password.service.js";
import { RefreshCookie } from "./refresh-cookie.service.js";
import { RefreshTokenService } from "./refresh-token.service.js";

@Module({
  imports: [UsersModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    AccessTokenService,
    RefreshTokenService,
    RefreshCookie,
    AuthUserDirectory,
    AllowedOriginGuard,
    // Order matters: limit by IP first, so a flood of bad tokens is stopped before any work is done.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
  // The socket gateway authenticates with the same two services.
  exports: [AccessTokenService, AuthUserDirectory],
})
export class AuthModule {}
