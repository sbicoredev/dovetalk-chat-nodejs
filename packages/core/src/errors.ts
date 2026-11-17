import { type ApiErrorBody, ERROR_STATUS, type ErrorCode } from "@dovetalk/contracts";

/**
 * An expected failure with a stable code the web app can react to, such as `PIN_LIMIT`.
 * Services throw these. The API turns them into the JSON error body, and a worker job can log
 * them. The HTTP status comes from the code, so the two can never disagree.
 */
export class DomainError extends Error {
  readonly status: number;
  /** One entry per problem. Validation failures can have several, everything else has one. */
  readonly messages: string[];
  private readonly asList: boolean;

  constructor(
    readonly code: ErrorCode,
    message: string | string[],
    options?: ErrorOptions,
  ) {
    const messages = Array.isArray(message) ? message : [message];
    super(messages.join(" "), options);
    this.name = "DomainError";
    this.status = ERROR_STATUS[code];
    this.messages = messages;
    this.asList = Array.isArray(message);
  }

  /**
   * The response body. `message` is an array exactly when the error was made with one, so
   * validation errors are always lists (even of one) and every other error is a plain string.
   */
  toBody(): ApiErrorBody {
    return {
      statusCode: this.status,
      code: this.code,
      message: this.asList ? this.messages : (this.messages[0] ?? ""),
    };
  }
}

export const isDomainError = (error: unknown): error is DomainError => error instanceof DomainError;
