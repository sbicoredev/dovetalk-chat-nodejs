import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from "@nestjs/common";
import type { Response } from "express";

import { type ApiErrorBody, ERROR_STATUS, type ErrorCode } from "@dovetalk/contracts";
import { DomainError } from "@dovetalk/core";

/** The code for an HTTP status that did not come from one of our own errors. */
function codeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 413:
      return "PAYLOAD_TOO_LARGE";
    case 422:
      return "VALIDATION_ERROR";
    case 429:
      return "RATE_LIMITED";
    default:
      return status >= 500 ? "INTERNAL_ERROR" : "BAD_REQUEST";
  }
}

const FRIENDLY = {
  BAD_REQUEST: "The request couldn't be understood.",
  UNAUTHORIZED: "Your session has ended. Sign in again.",
  FORBIDDEN: "You don't have permission to do that.",
  NOT_FOUND: "That doesn't exist.",
  PAYLOAD_TOO_LARGE: "That request is too large.",
  RATE_LIMITED: "Too many attempts. Wait a moment and try again.",
  INTERNAL_ERROR: "Something went wrong on our side. Try again in a moment.",
} as const satisfies Partial<Record<ErrorCode, string>>;
const FRIENDLY_BY_CODE: Partial<Record<ErrorCode, string>> = FRIENDLY;

/** Errors thrown by Express itself, for example body-parser when the JSON is broken. */
interface HttpLikeError {
  expose?: boolean;
  status?: number;
  statusCode?: number;
  type?: string;
}

/**
 * Turns every failure into the body the web app expects: `{ statusCode, code, message }`.
 * Messages of 5xx errors are never passed on, because they can contain SQL, paths or secrets.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger("Errors");

  catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== "http") {
      throw exception;
    }
    const response = host.switchToHttp().getResponse<Response>();
    const request = host
      .switchToHttp()
      .getRequest<{ method?: string; url?: string; id?: string }>();
    const body = this.toBody(exception);

    if (body.statusCode >= 500) {
      this.logger.error(
        { err: exception, requestId: request.id, method: request.method, url: request.url },
        "Unhandled error",
      );
    }
    if (response.headersSent) {
      return;
    }
    response.status(body.statusCode).json(body);
  }

  private toBody(exception: unknown): ApiErrorBody {
    if (exception instanceof DomainError) {
      return exception.toBody();
    }

    // Nest 12 wraps body-parser failures in an HttpException and keeps the original as `cause`.
    // Older versions threw the parser's own error. Handle both.
    const parserError = this.bodyParserError(
      exception instanceof HttpException ? exception.cause : exception,
    );
    if (parserError) {
      return parserError;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const code = codeForStatus(status);
      const response = exception.getResponse();
      const message =
        typeof response === "object" && response && "message" in response
          ? (response as { message: string | string[] }).message
          : exception.message;
      return {
        statusCode: status,
        code,
        message: status >= 500 ? FRIENDLY.INTERNAL_ERROR : this.clean(code, message),
      };
    }

    const http = exception as HttpLikeError | null;
    const status = http?.status ?? http?.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      const code = codeForStatus(status);
      return {
        statusCode: ERROR_STATUS[code],
        code,
        message: FRIENDLY_BY_CODE[code] ?? FRIENDLY.BAD_REQUEST,
      };
    }

    return { statusCode: 500, code: "INTERNAL_ERROR", message: FRIENDLY.INTERNAL_ERROR };
  }

  /** The standard body for a request body that body-parser rejected, or null for any other error. */
  private bodyParserError(error: unknown): ApiErrorBody | null {
    const type = (error as HttpLikeError | null | undefined)?.type;
    if (type === "entity.parse.failed") {
      return {
        statusCode: 400,
        code: "BAD_REQUEST",
        message: "The request body isn't valid JSON.",
      };
    }
    if (type === "entity.too.large") {
      return {
        statusCode: ERROR_STATUS.PAYLOAD_TOO_LARGE,
        code: "PAYLOAD_TOO_LARGE",
        message: FRIENDLY.PAYLOAD_TOO_LARGE,
      };
    }
    return null;
  }

  /** Framework messages such as "Cannot GET /x" are not written for people. Ours are kept. */
  private clean(code: ErrorCode, message: string | string[]): string | string[] {
    if (code === "NOT_FOUND" && typeof message === "string" && message.startsWith("Cannot ")) {
      return FRIENDLY.NOT_FOUND;
    }
    return message;
  }
}
