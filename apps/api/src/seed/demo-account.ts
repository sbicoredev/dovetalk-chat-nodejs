import { z } from "zod";

import { DEMO_EMAIL, DEMO_PASSWORD } from "@dovetalk/contracts";
import { DomainError, type OnboardingService } from "@dovetalk/core";
import type { Database } from "@dovetalk/db";

import type { PasswordService } from "../auth/password.service.js";
import type { UsersService } from "../users/users.service.js";

/** The environment the seed command reads. It needs a database and nothing else. */
export const seedEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/u }),
  /**
   * The demo account's password is public (it is in the README), so it must never exist on a
   * server by accident. Nothing is seeded unless this is set (docs/edge-cases.md, #31).
   */
  SEED_DEMO_ACCOUNT: z.stringbool().default(false),
});

/** Matches the signed-in person in the web app's mock data, so both backends look the same. */
export const DEMO_NAME = "Alex Rivera";
export const DEMO_HUE = 40;

/**
 * - `created`: the account did not exist and now has its contacts, chats and messages.
 * - `onboarded`: the account existed without any contacts (a demo account made before contacts existed) and got them.
 * - `exists`: nothing to do. The account is left exactly as it is.
 */
export type DemoSeedResult = "created" | "onboarded" | "exists";

interface Dependencies {
  db: Pick<Database, "transaction">;
  onboarding: Pick<OnboardingService, "ensureBots" | "onboard" | "onboardIfEmpty">;
  passwords: Pick<PasswordService, "hash">;
  users: Pick<UsersService, "findSignInByEmail" | "createAccount">;
}

/**
 * Creates the demo account, with the same starting contacts, chats and messages every new
 * account gets, if it is not there yet. Safe to run on every deploy: an account that already has
 * data is left exactly as it is, so a changed name or password is not undone. An account that
 * exists but has no contacts at all (one made before contacts existed) is given them once.
 */
export async function seedDemoAccount({
  users,
  passwords,
  onboarding,
  db,
}: Dependencies): Promise<DemoSeedResult> {
  const existing = await users.findSignInByEmail(DEMO_EMAIL);
  if (existing) {
    return fillIfEmpty(onboarding, existing.id);
  }

  const passwordHash = await passwords.hash(DEMO_PASSWORD);
  // Before the transaction, so the first call has a connection of its own to use.
  await onboarding.ensureBots();
  try {
    await db.transaction(async (tx) => {
      const account = await users.createAccount(
        { email: DEMO_EMAIL, passwordHash, name: DEMO_NAME, hue: DEMO_HUE },
        tx,
      );
      await onboarding.onboard(tx, account.id);
    });
    return "created";
  } catch (error) {
    // Two seeds started at once: the other one made the account, which is the outcome we wanted.
    // It may still be onboarding, and onboardIfEmpty waits for it on the same lock.
    if (error instanceof DomainError && error.code === "EMAIL_TAKEN") {
      const winner = await users.findSignInByEmail(DEMO_EMAIL);
      return winner ? fillIfEmpty(onboarding, winner.id) : "exists";
    }
    throw error;
  }
}

async function fillIfEmpty(
  onboarding: Dependencies["onboarding"],
  userId: string,
): Promise<DemoSeedResult> {
  return (await onboarding.onboardIfEmpty(userId)) ? "onboarded" : "exists";
}
