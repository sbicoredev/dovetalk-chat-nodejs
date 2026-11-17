import { Inject, Injectable } from "@nestjs/common";

import { type AuthResult, GUEST_EMAIL_DOMAIN } from "@dovetalk/contracts";
import { DomainError, DRIZZLE, OnboardingService } from "@dovetalk/core";
import type { Database, UserRow } from "@dovetalk/db";

import { ProfileService } from "../users/profile.service.js";
import { UsersService } from "../users/users.service.js";
import { AccessTokenService } from "./access-token.service.js";
import type { LoginDto, RegisterDto } from "./dto.js";
import { PasswordService } from "./password.service.js";
import { type IssuedRefreshToken, RefreshTokenService } from "./refresh-token.service.js";

/** What every sign-in produces: the body for the client, and the refresh token for the cookie. */
export interface Session {
  refresh: IssuedRefreshToken;
  result: AuthResult;
}

@Injectable()
export class AuthService {
  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(ProfileService) private readonly profiles: ProfileService,
    @Inject(PasswordService) private readonly passwords: PasswordService,
    @Inject(AccessTokenService) private readonly accessTokens: AccessTokenService,
    @Inject(RefreshTokenService) private readonly refreshTokens: RefreshTokenService,
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(OnboardingService) private readonly onboarding: OnboardingService,
  ) {}

  async register(input: RegisterDto, userAgent: string | undefined): Promise<Session> {
    // Guest addresses are generated. Nobody may register one and sit on a guest's identity.
    if (input.email.endsWith(`@${GUEST_EMAIL_DOMAIN}`)) {
      throw new DomainError("VALIDATION_ERROR", ["Enter a valid email address."]);
    }
    // Hashing is slow, so it happens before the transaction opens and holds no connection.
    const passwordHash = await this.passwords.hash(input.password);
    // The shared bots must exist before a transaction needs them (see OnboardingService).
    await this.onboarding.ensureBots();
    // The account and its starting contacts, chats and messages are one unit: a failure
    // (EMAIL_TAKEN included) leaves nothing behind.
    const user = await this.db.transaction(async (tx) => {
      const created = await this.users.createAccount(
        { email: input.email, passwordHash, name: input.name, phone: input.phone },
        tx,
      );
      await this.onboarding.onboard(tx, created.id);
      return created;
    });
    return this.startSession(user, userAgent);
  }

  async login(input: LoginDto, userAgent: string | undefined): Promise<Session> {
    const user = await this.users.findSignInByEmail(input.email);
    // Verified even when there is no user, so unknown emails take as long as wrong passwords.
    const valid = await this.passwords.verify(user?.passwordHash, input.password);
    if (!(user && valid)) {
      throw new DomainError("INVALID_CREDENTIALS", "Email or password is incorrect.");
    }
    return this.startSession(user, userAgent);
  }

  async guest(userAgent: string | undefined): Promise<Session> {
    await this.onboarding.ensureBots();
    const user = await this.db.transaction(async (tx) => {
      const created = await this.users.createGuest(tx);
      await this.onboarding.onboard(tx, created.id);
      return created;
    });
    return this.startSession(user, userAgent);
  }

  /** Trades the refresh cookie for a new access token and the next cookie. */
  async refresh(token: string | undefined, userAgent: string | undefined): Promise<Session> {
    const { userId, refresh } = await this.refreshTokens.rotate(token, userAgent);
    const user = await this.users.findById(userId);
    if (!user) {
      throw new DomainError("UNAUTHORIZED", "Your session has ended. Sign in again.");
    }
    return {
      result: {
        accessToken: await this.accessTokens.sign(user.id),
        user: await this.profiles.toMe(user),
      },
      refresh,
    };
  }

  /** Ends this sign-in on this device. Other devices stay signed in. */
  logout(token: string | undefined): Promise<void> {
    return this.refreshTokens.revokeFamilyOf(token);
  }

  private async startSession(user: UserRow, userAgent: string | undefined): Promise<Session> {
    const [accessToken, refresh] = await Promise.all([
      this.accessTokens.sign(user.id),
      this.refreshTokens.issue(user.id, userAgent),
    ]);
    return { result: { accessToken, user: await this.profiles.toMe(user) }, refresh };
  }
}
