import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";

import { DomainError } from "@dovetalk/core";

import { IS_PUBLIC } from "../common/decorators.js";
import { AccessTokenService } from "./access-token.service.js";
import { AuthUserDirectory } from "./auth-user.directory.js";

const unauthorized = () =>
  new DomainError("UNAUTHORIZED", "Your session has ended. Sign in again.");

const BEARER = /^Bearer (?<token>\S+)$/iu;

/** The token in `Authorization: Bearer <token>`, or undefined. */
export function bearerToken(header: string | undefined): string | undefined {
  return BEARER.exec(header ?? "")?.groups?.token;
}

/**
 * Global guard: every route needs a valid access token unless it is marked @Public().
 * Sets `request.user` for the controllers behind it.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokenService,
    private readonly directory: AuthUserDirectory,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (
      this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const token = bearerToken(request.headers.authorization);
    const userId = token ? await this.tokens.verify(token) : null;
    const user = userId ? await this.directory.find(userId) : null;
    if (!user) {
      throw unauthorized();
    }

    request.user = user;
    return true;
  }
}
