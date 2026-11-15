/**
 * Every failed request ends up as an ApiError, whether it came from the network,
 * a Nest exception filter or the mock server.
 *
 * `message` is written for people and is safe to show. `code` is a stable
 * machine-readable string such as "PIN_LIMIT" or "CONTACT_BLOCKED".
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

/** A message that is always safe to show someone. */
export function errorMessage(error: unknown): string {
  if (isApiError(error)) {
    return error.message;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return "Something went wrong. Try again.";
}
