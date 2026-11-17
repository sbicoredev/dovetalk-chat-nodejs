import { ConfigError, OnboardingService, parseEnv } from "@dovetalk/core";
import { createDatabase } from "@dovetalk/db";

import { PasswordService } from "../auth/password.service.js";
import { seedDemoAccount, seedEnvSchema } from "../seed/demo-account.js";
import { UsersService } from "../users/users.service.js";

/**
 * Seeds the data a fresh environment needs. Run after the migrations:
 *
 *   SEED_DEMO_ACCOUNT=true pnpm --filter @dovetalk/api db:seed
 *
 * It lives in the API app and not in packages/db because it hashes a password, and the db
 * package may only depend on contracts.
 */
function readEnv() {
  try {
    return parseEnv(seedEnvSchema, process.env, "dovetalk-seed");
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

const env = readEnv();

if (!env.SEED_DEMO_ACCOUNT) {
  console.log("SEED_DEMO_ACCOUNT is not set, so there is nothing to seed.");
  process.exit(0);
}

const { db, close } = createDatabase({
  url: env.DATABASE_URL,
  poolMax: 2,
  applicationName: "dovetalk-seed",
  statementTimeoutMs: 0,
});

try {
  const result = await seedDemoAccount({
    users: new UsersService(db),
    passwords: new PasswordService(),
    onboarding: new OnboardingService(db),
    db,
  });
  const messages = {
    created: "Created the demo account with its contacts, chats and messages.",
    onboarded:
      "The demo account existed without contacts. Gave it its contacts, chats and messages.",
    exists: "The demo account already exists.",
  } satisfies Record<typeof result, string>;
  console.log(messages[result]);
} catch (error) {
  console.error("Seeding failed:", error);
  process.exitCode = 1;
} finally {
  await close();
}
