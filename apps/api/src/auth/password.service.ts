import { Injectable, type OnModuleInit } from "@nestjs/common";
import { type Algorithm, hash, verify } from "@node-rs/argon2";

/** OWASP's minimum for Argon2id: 19 MiB of memory, 2 passes, 1 lane. Takes about 25 ms. */
const ARGON2 = {
  // Algorithm.Argon2id. The library exports a const enum, which cannot be imported as a value here.
  algorithm: 2 as Algorithm,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class PasswordService implements OnModuleInit {
  /** A real hash nobody knows the password for. See `verify`. */
  private dummyHash: string | undefined;

  async onModuleInit() {
    await this.getDummyHash();
  }

  hash(password: string): Promise<string> {
    return hash(password, ARGON2);
  }

  /**
   * Checks a password. With no stored hash (unknown email, guest, bot) it still does the full
   * work against a dummy hash, so how long the answer takes does not reveal whether an
   * account exists. Always false in that case.
   */
  async verify(storedHash: string | null | undefined, password: string): Promise<boolean> {
    if (!storedHash) {
      await verify(await this.getDummyHash(), password).catch(() => false);
      return false;
    }
    try {
      return await verify(storedHash, password);
    } catch {
      // A malformed stored hash is a data problem, not a reason to let anyone in.
      return false;
    }
  }

  private async getDummyHash(): Promise<string> {
    this.dummyHash ??= await this.hash("dovetalk-no-such-account");
    return this.dummyHash;
  }
}
