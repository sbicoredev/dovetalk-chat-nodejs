/**
 * Every error code the API can send. The first group is the table in docs/API.md and the
 * web app relies on it. The second group are additions the backend needs.
 */
export const ERROR_STATUS = {
  // Documented in docs/API.md
  UNAUTHORIZED: 401,
  INVALID_CREDENTIALS: 401,
  CONTACT_BLOCKED: 403,
  FORBIDDEN: 403,
  CHAT_NOT_FOUND: 404,
  CONTACT_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  STATUS_NOT_FOUND: 404,
  MEMBER_NOT_FOUND: 404,
  PIN_LIMIT: 409,
  FILE_TOO_LARGE: 413,
  INVALID_CURSOR: 400,
  VALIDATION_ERROR: 422,
  ATTACHMENT_NOT_FOUND: 422,
  // Added by the backend
  EMAIL_TAKEN: 409,
  PHONE_TAKEN: 409,
  RATE_LIMITED: 429,
  /** A malformed request that is not a validation problem, such as broken JSON. */
  BAD_REQUEST: 400,
  /** A JSON body over the size limit. Uploads use FILE_TOO_LARGE. */
  PAYLOAD_TOO_LARGE: 413,
  NOT_FOUND: 404,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

export const ERROR_CODES = Object.keys(ERROR_STATUS) as ErrorCode[];

/** The JSON body of every non-2xx response. `message` is an array for validation failures. */
export interface ApiErrorBody {
  code: ErrorCode;
  message: string | string[];
  statusCode: number;
}

export const isErrorCode = (value: unknown): value is ErrorCode =>
  typeof value === "string" && Object.hasOwn(ERROR_STATUS, value);
