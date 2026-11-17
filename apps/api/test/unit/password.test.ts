import { describe, expect, it } from "vitest";

import { PasswordService } from "../../src/auth/password.service.js";

const service = new PasswordService();

describe("PasswordService", () => {
  it("hashes with Argon2id at the OWASP minimum and salts every hash", async () => {
    const [a, b] = await Promise.all([
      service.hash("hunter2hunter2"),
      service.hash("hunter2hunter2"),
    ]);
    expect(a).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/u);
    expect(a).not.toBe(b);
  });

  it("verifies the right password and rejects the wrong one", async () => {
    const hash = await service.hash("correct horse");
    expect(await service.verify(hash, "correct horse")).toBe(true);
    expect(await service.verify(hash, "correct horsf")).toBe(false);
    expect(await service.verify(hash, "")).toBe(false);
  });

  it("is false, and still does the work, when there is no hash", async () => {
    expect(await service.verify(null, "anything")).toBe(false);
    expect(await service.verify(undefined, "anything")).toBe(false);
    expect(await service.verify("", "anything")).toBe(false);
  });

  it("is false for a stored value that is not a hash, instead of throwing", async () => {
    expect(await service.verify("not-a-hash", "x")).toBe(false);
  });

  it("handles unicode and very long passwords", async () => {
    const hash = await service.hash("pässwörd-密码-🔑");
    expect(await service.verify(hash, "pässwörd-密码-🔑")).toBe(true);
    const long = "x".repeat(128);
    expect(await service.verify(await service.hash(long), long)).toBe(true);
  });
});
