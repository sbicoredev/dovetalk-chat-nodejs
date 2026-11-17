import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
} from "@nestjs/common";
import type { Request, Response } from "express";
import multer from "multer";
import type { Observable } from "rxjs";

import { UPLOAD_LIMIT_BYTES } from "@dovetalk/contracts";
import { DomainError, tooLarge } from "@dovetalk/core";

/** The field the file travels in. The web app's `createHttpApi` uses the same name. */
export const UPLOAD_FIELD = "file";

/** Text fields next to the file are small: a name and two numbers. */
const FIELD_VALUE_MAX = 1024;

const parseUpload = multer({
  // The whole file is held in memory: 10 MB at most, then checked and sent to storage in one go.
  // The type of a file is read from its first bytes, which needs them in hand (docs/edge-cases.md).
  storage: multer.memoryStorage(),
  // Busboy reads file names as latin1 unless told otherwise, which would turn "Büro.pdf" into
  // "BÃ¼ro.pdf". Browsers send UTF-8.
  defParamCharset: "utf8",
  limits: {
    fileSize: UPLOAD_LIMIT_BYTES,
    files: 1,
    fields: 8,
    parts: 9,
    fieldSize: FIELD_VALUE_MAX,
  },
}).single(UPLOAD_FIELD);

/** Turns what multer throws into our own errors, so the body is `{ statusCode, code, message }`. */
function toDomainError(error: unknown): unknown {
  if (error instanceof multer.MulterError) {
    switch (error.code) {
      case "LIMIT_FILE_SIZE":
        return tooLarge();
      case "LIMIT_UNEXPECTED_FILE":
        return new DomainError("VALIDATION_ERROR", [
          `Send the file in a field named "${UPLOAD_FIELD}", one file at a time.`,
        ]);
      case "LIMIT_FILE_COUNT":
        return new DomainError("VALIDATION_ERROR", ["Send one file at a time."]);
      default:
        return new DomainError("VALIDATION_ERROR", ["The upload couldn't be read."]);
    }
  }
  // Busboy's own errors: a body that is cut off or is not valid multipart.
  if (error instanceof Error && !(error instanceof DomainError)) {
    return new DomainError("VALIDATION_ERROR", ["The upload couldn't be read."]);
  }
  return error;
}

/**
 * Reads a `multipart/form-data` request before the route runs: the file lands on `req.file` and
 * the other fields on `req.body`. A request that is not multipart passes through untouched, and
 * the route answers that no file was sent.
 */
@Injectable()
export class UploadInterceptor implements NestInterceptor {
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    await new Promise<void>((resolve, reject) => {
      parseUpload(request, response, (error: unknown) => {
        if (error) {
          reject(toDomainError(error));
        } else {
          resolve();
        }
      });
    });
    return next.handle();
  }
}
