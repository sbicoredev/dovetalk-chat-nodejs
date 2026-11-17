import { Body, Controller, HttpCode, Post, Req, Res, UseGuards } from "@nestjs/common";
import {
  ApiBody,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import type { Request, Response } from "express";

import type { AuthResult } from "@dovetalk/contracts";
import { DomainError } from "@dovetalk/core";

import { Public, RateLimit } from "../common/decorators.js";
import { AuthResultModel, COOKIE_NOTE, ErrorModel } from "../docs/models.js";
import { AllowedOriginGuard } from "./allowed-origin.guard.js";
import { AuthService, type Session } from "./auth.service.js";
import { LoginDto, RegisterDto } from "./dto.js";
import { REFRESH_COOKIE, RefreshCookie } from "./refresh-cookie.service.js";

@ApiTags("auth")
@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cookie: RefreshCookie,
  ) {}

  @Public()
  @RateLimit("register")
  @Post("register")
  @ApiOperation({ summary: "Create an account and sign in.", description: COOKIE_NOTE })
  @ApiBody({
    type: RegisterDto,
    examples: {
      minimal: {
        value: { email: "sam@example.com", password: "correct horse battery", name: "Sam Lee" },
      },
      withPhone: {
        value: {
          email: "sam@example.com",
          password: "correct horse battery",
          name: "Sam Lee",
          phone: "+1 555 010 0142",
        },
      },
    },
  })
  @ApiCreatedResponse({ type: AuthResultModel })
  @ApiResponse({ status: 409, type: ErrorModel, description: "`EMAIL_TAKEN` or `PHONE_TAKEN`." })
  @ApiResponse({
    status: 422,
    type: ErrorModel,
    description: "`VALIDATION_ERROR`. `message` lists every problem.",
  })
  @ApiResponse({
    status: 429,
    type: ErrorModel,
    description: "`RATE_LIMITED`. See the `Retry-After` header.",
  })
  async register(
    @Body() body: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.auth.register(body, req.headers["user-agent"]));
  }

  @Public()
  @RateLimit("login")
  @Post("login")
  @HttpCode(200)
  @ApiOperation({ summary: "Sign in with email and password.", description: COOKIE_NOTE })
  @ApiBody({
    type: LoginDto,
    examples: {
      demo: {
        summary: "The demo account",
        value: { email: "demo@dovetalk.app", password: "dovetalk123" },
      },
    },
  })
  @ApiOkResponse({ type: AuthResultModel })
  @ApiResponse({
    status: 401,
    type: ErrorModel,
    description: "`INVALID_CREDENTIALS`. Same answer for an unknown email and a wrong password.",
  })
  @ApiResponse({
    status: 429,
    type: ErrorModel,
    description: "`RATE_LIMITED`. Limited per IP and per email.",
  })
  async login(
    @Body() body: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.respond(res, await this.auth.login(body, req.headers["user-agent"]));
  }

  @Public()
  @RateLimit("guest")
  @Post("guest")
  @ApiOperation({
    summary: "Start a throwaway guest account.",
    description: `For the live demo: one click, no form. The account and its data are deleted after 24 hours. ${COOKIE_NOTE}`,
  })
  @ApiCreatedResponse({ type: AuthResultModel })
  @ApiResponse({ status: 429, type: ErrorModel, description: "`RATE_LIMITED`." })
  async guest(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.respond(res, await this.auth.guest(req.headers["user-agent"]));
  }

  @Public()
  @RateLimit("refresh")
  @UseGuards(AllowedOriginGuard)
  @Post("refresh")
  @HttpCode(200)
  @ApiCookieAuth(REFRESH_COOKIE)
  @ApiOperation({
    summary: "Get a new access token using the refresh cookie.",
    description:
      "Call it when the page loads and whenever a request fails with 401. Every call rotates the cookie: the old token stops working, apart from a 10 second grace for double requests. Using an old token after that signs the whole device out.",
  })
  @ApiOkResponse({ type: AuthResultModel })
  @ApiResponse({
    status: 401,
    type: ErrorModel,
    description: "`UNAUTHORIZED`. The cookie is cleared. Show the login screen.",
  })
  @ApiResponse({
    status: 403,
    type: ErrorModel,
    description: "`FORBIDDEN`. The `Origin` header is not an allowed web origin.",
  })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    try {
      return this.respond(
        res,
        await this.auth.refresh(this.cookie.read(req), req.headers["user-agent"]),
      );
    } catch (error) {
      if (error instanceof DomainError && error.code === "UNAUTHORIZED") {
        this.cookie.clear(res);
      }
      throw error;
    }
  }

  @Public()
  @UseGuards(AllowedOriginGuard)
  @Post("logout")
  @HttpCode(204)
  @ApiCookieAuth(REFRESH_COOKIE)
  @ApiOperation({
    summary: "Sign out on this device.",
    description:
      "Revokes the refresh token's sign-in and clears the cookie. Needs no access token, so it works when that has expired. Safe to call twice. The access token keeps working until it expires (at most 15 minutes).",
  })
  @ApiNoContentResponse()
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(this.cookie.read(req));
    this.cookie.clear(res);
  }

  /** Sets the refresh cookie and returns the body. */
  private respond(res: Response, session: Session): AuthResult {
    this.cookie.set(res, session.refresh.token, session.refresh.expiresAt);
    return session.result;
  }
}
