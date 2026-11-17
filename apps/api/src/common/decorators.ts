import { createParamDecorator, type ExecutionContext, SetMetadata } from "@nestjs/common";

import type { AuthUser } from "./auth-user.js";

export const IS_PUBLIC = "dovetalk:public";
/** Opts a route out of the global JwtAuthGuard. Everything else needs a valid access token. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** The signed-in user. Only meaningful on routes that are not @Public(). */
export const CurrentUser = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const { user } = context.switchToHttp().getRequest<{ user?: AuthUser }>();
  if (!user) {
    throw new Error("CurrentUser used on a route the auth guard did not protect.");
  }
  return user;
});

export const RATE_LIMIT_PROFILE = "dovetalk:rate-limit-profile";
export type RateLimitProfile =
  | "default"
  | "login"
  | "register"
  | "guest"
  | "refresh"
  /** No limit. For health probes. */
  | "none";
/** Picks the rate limit a route uses. Routes without one get the default. */
export const RateLimit = (profile: RateLimitProfile) => SetMetadata(RATE_LIMIT_PROFILE, profile);
