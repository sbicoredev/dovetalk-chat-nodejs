import { type CanActivate, type ExecutionContext, Inject, Injectable } from "@nestjs/common";
import type { Request } from "express";

import { DomainError } from "@dovetalk/core";

import { API_ENV, type ApiEnv } from "../config/env.js";

/**
 * Cookie-authenticated routes (refresh, logout) refuse a browser request that comes from a page
 * on another site. SameSite already keeps the cookie off such requests. This is the second lock.
 * A request with no Origin header is not from a cross-site page, so it passes: that is curl,
 * mobile apps and server-to-server calls.
 */
@Injectable()
export class AllowedOriginGuard implements CanActivate {
  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  canActivate(context: ExecutionContext): boolean {
    const { origin } = context.switchToHttp().getRequest<Request>().headers;
    if (origin === undefined || this.env.CORS_ORIGINS.includes(origin)) {
      return true;
    }
    throw new DomainError("FORBIDDEN", "That site isn't allowed to do this.");
  }
}
