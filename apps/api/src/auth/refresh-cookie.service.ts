import { Inject, Injectable } from "@nestjs/common";
import { parseCookie } from "cookie";
import type { CookieOptions, Request, Response } from "express";

import { API_ENV, type ApiEnv } from "../config/env.js";

export const REFRESH_COOKIE = "dt_refresh";

/**
 * The refresh token's cookie. HttpOnly, so page scripts (and anything injected into them)
 * cannot read it, and scoped to the auth routes so it is not sent with every API call.
 */
@Injectable()
export class RefreshCookie {
  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  set(response: Response, token: string, expiresAt: Date) {
    response.cookie(REFRESH_COOKIE, token, { ...this.options(), expires: expiresAt });
  }

  clear(response: Response) {
    response.clearCookie(REFRESH_COOKIE, this.options());
  }

  read(request: Request): string | undefined {
    const header = request.headers.cookie;
    return header ? parseCookie(header)[REFRESH_COOKIE] : undefined;
  }

  private options(): CookieOptions {
    return {
      httpOnly: true,
      secure: this.env.COOKIE_SECURE,
      sameSite: this.env.COOKIE_SAMESITE,
      domain: this.env.COOKIE_DOMAIN,
      path: this.env.COOKIE_PATH,
    };
  }
}
