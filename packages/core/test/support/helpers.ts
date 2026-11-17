import { DomainError } from "../../src/errors.js";

/** The code of the DomainError a call fails with, or undefined if it succeeds. Other errors rethrow. */
export async function codeOf(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    if (error instanceof DomainError) {
      return error.code;
    }
    throw error;
  }
  return undefined;
}
