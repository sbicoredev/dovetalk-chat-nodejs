import { Inject, Injectable } from "@nestjs/common";
import { jwtVerify, SignJWT } from "jose";

import { API_ENV, type ApiEnv } from "../config/env.js";

const ISSUER = "dovetalk-api";
const AUDIENCE = "dovetalk";

/**
 * Short-lived JWTs that prove who is calling. The only claim that matters is `sub`, the user id.
 * Nothing about the person is put in the token, so a profile change never makes one stale.
 * HS256 with a secret every API instance shares, so any instance can check a token without a lookup.
 */
@Injectable()
export class AccessTokenService {
  private readonly key: Uint8Array;

  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {
    this.key = new TextEncoder().encode(env.JWT_SECRET);
  }

  async sign(userId: string): Promise<string> {
    return new SignJWT({})
      .setProtectedHeader({ alg: "HS256", typ: "at+jwt" })
      .setSubject(userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.env.ACCESS_TOKEN_TTL_SECONDS}s`)
      .sign(this.key);
  }

  /** The user id in a valid, unexpired token, or null. Never throws for a bad token. */
  async verify(token: string): Promise<string | null> {
    return (await this.verifyWithExpiry(token))?.userId ?? null;
  }

  /**
   * Like `verify`, and also says when the token stops being valid (epoch milliseconds). A socket
   * is checked once, when it connects, so it needs to know when to stop trusting it.
   */
  async verifyWithExpiry(token: string): Promise<{ expiresAt: number; userId: string } | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ["HS256"],
        issuer: ISSUER,
        audience: AUDIENCE,
        clockTolerance: 5,
        requiredClaims: ["sub", "exp"],
      });
      if (typeof payload.sub !== "string" || typeof payload.exp !== "number") {
        return null;
      }
      return { userId: payload.sub, expiresAt: payload.exp * 1000 };
    } catch {
      return null;
    }
  }
}
