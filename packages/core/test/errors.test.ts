import { describe, expect, it } from "vitest";

import { DomainError, isDomainError } from "../src/index.js";

describe("DomainError", () => {
  it("takes its status from the code", () => {
    const error = new DomainError("PIN_LIMIT", "You can pin up to 3 chats.");
    expect(error).toMatchObject({ status: 409, code: "PIN_LIMIT", name: "DomainError" });
    expect(error.message).toBe("You can pin up to 3 chats.");
    expect(isDomainError(error)).toBe(true);
    expect(isDomainError(new Error("x"))).toBe(false);
  });

  it("builds the body with a string, or with a list if it was made with one", () => {
    expect(new DomainError("EMAIL_TAKEN", "Taken.").toBody()).toEqual({
      statusCode: 409,
      code: "EMAIL_TAKEN",
      message: "Taken.",
    });
    const many = new DomainError("VALIDATION_ERROR", ["Enter a name.", "Enter an email."]);
    expect(many.toBody()).toEqual({
      statusCode: 422,
      code: "VALIDATION_ERROR",
      message: ["Enter a name.", "Enter an email."],
    });
    expect(many.message).toBe("Enter a name. Enter an email.");
    // A list of one stays a list: validation errors always have the same shape.
    expect(new DomainError("VALIDATION_ERROR", ["Enter a name."]).toBody().message).toEqual([
      "Enter a name.",
    ]);
  });

  it("keeps the cause", () => {
    const cause = new Error("db down");
    expect(new DomainError("INTERNAL_ERROR", "Oops", { cause }).cause).toBe(cause);
  });
});
