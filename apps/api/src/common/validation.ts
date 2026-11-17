import { type ValidationError, ValidationPipe } from "@nestjs/common";
import { Transform } from "class-transformer";
import { registerDecorator, type ValidationOptions } from "class-validator";

import { DomainError, PHONE_MESSAGE, parsePhone } from "@dovetalk/core";

/** Every message from a failed validation, including the ones on nested objects. */
function collectMessages(errors: ValidationError[]): string[] {
  return errors.flatMap((error) => [
    ...Object.values(error.constraints ?? {}),
    ...collectMessages(error.children ?? []),
  ]);
}

/**
 * Whether any string in a parsed JSON value, or any key, holds a NUL character. Postgres cannot
 * store one in text (it fails with a 500), so every endpoint refuses it up front instead of
 * each DTO having to remember to. Walks with a list, not recursion, so a deeply nested body
 * cannot overflow the stack.
 */
export function containsNul(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const item = pending.pop();
    if (typeof item === "string") {
      if (item.includes("\u0000")) {
        return true;
      }
    } else if (Array.isArray(item)) {
      pending.push(...item);
    } else if (item !== null && typeof item === "object") {
      for (const [key, inner] of Object.entries(item)) {
        if (key.includes("\u0000")) {
          return true;
        }
        pending.push(inner);
      }
    }
  }
  return false;
}

/**
 * Validates request bodies and query strings against the DTO classes.
 *
 * - Failures are 422 `VALIDATION_ERROR` with a list of messages, not Nest's default 400.
 * - Properties a DTO does not declare are dropped, so a client cannot set fields by guessing names.
 * - A NUL character anywhere in a body, in a value or a key, is a 422 (see containsNul).
 * - A missing body is treated as an empty one, so the person sees "Enter your email." and not
 *   "an unknown value was passed".
 */
export function createValidationPipe(): ValidationPipe {
  return new (class extends ValidationPipe {
    override async transform(value: unknown, metadata: Parameters<ValidationPipe["transform"]>[1]) {
      if (metadata.type === "body") {
        const body = value === undefined || value === null ? {} : value;
        if (typeof body !== "object" || Array.isArray(body)) {
          throw new DomainError("VALIDATION_ERROR", ["The request body must be a JSON object."]);
        }
        if (containsNul(body)) {
          throw new DomainError("VALIDATION_ERROR", ["Text can't contain null characters."]);
        }
        return super.transform(body, metadata);
      }
      return super.transform(value, metadata);
    }
  })({
    transform: true,
    whitelist: true,
    // One message per field. Decorators run bottom-up, so DTOs list the most basic check last.
    stopAtFirstError: true,
    exceptionFactory: (errors) =>
      new DomainError(
        "VALIDATION_ERROR",
        collectMessages(errors).length > 0 ? collectMessages(errors) : "The request isn't valid.",
      ),
  });
}

/** Trims surrounding whitespace from a string. Other values pass through for the validators to reject. */
export const Trim = () =>
  Transform(({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value));

/** Trims, then lower-cases. For email addresses, which are stored and compared in lower case. */
export const Normalize = () =>
  Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toLowerCase() : value,
  );

/** A phone number as people type it. See parsePhone. */
export function IsPhone(options?: ValidationOptions) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: "isPhone",
      target: target.constructor,
      propertyName,
      options: { message: PHONE_MESSAGE, ...options },
      validator: {
        validate: (value: unknown) => typeof value === "string" && parsePhone(value) !== null,
      },
    });
}
