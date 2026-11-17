/**
 * The value, or a thrown error when a row or lookup that has to exist is missing. It marks a
 * programming error (a bug or a broken invariant), so it is a plain `Error` that becomes a 500.
 * Use `DomainError` for anything the caller can cause.
 */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`Expected ${what}, but there was none.`);
  }
  return value;
}
