import { describe, expect, it, vi } from "vitest";

import { DEMO_EMAIL, DEMO_PASSWORD } from "@dovetalk/contracts";
import { ConfigError, DomainError, parseEnv } from "@dovetalk/core";
import type { UserRow } from "@dovetalk/db";

import {
  DEMO_HUE,
  DEMO_NAME,
  seedDemoAccount,
  seedEnvSchema,
} from "../../src/seed/demo-account.js";

const anyUser = { id: "demo-user-id" } as UserRow;
const tx = { tx: true };

function fakes(found?: UserRow) {
  const calls: string[] = [];
  return {
    calls,
    users: {
      findSignInByEmail: vi.fn().mockResolvedValue(found),
      createAccount: vi.fn().mockResolvedValue(anyUser),
    },
    passwords: { hash: vi.fn().mockResolvedValue("hashed-password") },
    onboarding: {
      ensureBots: vi.fn().mockImplementation(async () => void calls.push("ensureBots")),
      onboard: vi.fn().mockImplementation(async () => void calls.push("onboard")),
      onboardIfEmpty: vi.fn().mockResolvedValue(false),
    },
    db: {
      transaction: vi.fn().mockImplementation(async (work: (t: unknown) => Promise<unknown>) => {
        calls.push("begin");
        const result = await work(tx);
        calls.push("commit");
        return result;
      }),
    },
  };
}

describe("seedDemoAccount", () => {
  it("creates the demo account with the same name and colour as the mock data", async () => {
    const deps = fakes();
    expect(await seedDemoAccount(deps)).toBe("created");
    expect(deps.passwords.hash).toHaveBeenCalledWith(DEMO_PASSWORD);
    expect(deps.users.createAccount).toHaveBeenCalledWith(
      { email: DEMO_EMAIL, passwordHash: "hashed-password", name: DEMO_NAME, hue: DEMO_HUE },
      tx,
    );
  });

  it("makes the account and its data in one transaction, with the bots ensured before it opens", async () => {
    const deps = fakes();
    await seedDemoAccount(deps);
    expect(deps.onboarding.onboard).toHaveBeenCalledWith(tx, anyUser.id);
    expect(deps.calls).toEqual(["ensureBots", "begin", "onboard", "commit"]);
  });

  it("leaves nothing behind when onboarding fails", async () => {
    const deps = fakes();
    deps.onboarding.onboard.mockRejectedValue(new Error("insert failed"));
    await expect(seedDemoAccount(deps)).rejects.toThrow("insert failed");
    expect(deps.calls).not.toContain("commit");
  });

  it("leaves an existing account that has data alone, without even hashing", async () => {
    const deps = fakes(anyUser);
    expect(await seedDemoAccount(deps)).toBe("exists");
    expect(deps.onboarding.onboardIfEmpty).toHaveBeenCalledWith(anyUser.id);
    expect(deps.passwords.hash).not.toHaveBeenCalled();
    expect(deps.users.createAccount).not.toHaveBeenCalled();
    expect(deps.db.transaction).not.toHaveBeenCalled();
  });

  it("gives an existing account without contacts its data, once", async () => {
    const deps = fakes(anyUser);
    deps.onboarding.onboardIfEmpty.mockResolvedValue(true);
    expect(await seedDemoAccount(deps)).toBe("onboarded");
    expect(deps.users.createAccount).not.toHaveBeenCalled();
  });

  it("treats losing a race with another seed as success", async () => {
    const deps = fakes();
    deps.users.createAccount.mockRejectedValue(new DomainError("EMAIL_TAKEN", "Taken."));
    deps.users.findSignInByEmail.mockResolvedValueOnce(undefined).mockResolvedValue(anyUser);
    expect(await seedDemoAccount(deps)).toBe("exists");
    expect(deps.onboarding.onboardIfEmpty).toHaveBeenCalledWith(anyUser.id);
  });

  it("does not hide other failures", async () => {
    const deps = fakes();
    deps.users.createAccount.mockRejectedValue(new Error("connection refused"));
    await expect(seedDemoAccount(deps)).rejects.toThrow("connection refused");
  });
});

describe("seed environment", () => {
  const url = "postgres://x@localhost/x";

  it("seeds nothing unless asked to", () => {
    expect(parseEnv(seedEnvSchema, { DATABASE_URL: url }, "seed").SEED_DEMO_ACCOUNT).toBe(false);
    expect(
      parseEnv(seedEnvSchema, { DATABASE_URL: url, SEED_DEMO_ACCOUNT: "false" }, "seed")
        .SEED_DEMO_ACCOUNT,
    ).toBe(false);
  });

  it("accepts the usual spellings of true", () => {
    for (const value of ["true", "1", "yes"]) {
      const env = { DATABASE_URL: url, SEED_DEMO_ACCOUNT: value };
      expect(parseEnv(seedEnvSchema, env, "seed").SEED_DEMO_ACCOUNT).toBe(true);
    }
  });

  it("needs a database", () => {
    expect(() => parseEnv(seedEnvSchema, {}, "seed")).toThrow(ConfigError);
  });
});
