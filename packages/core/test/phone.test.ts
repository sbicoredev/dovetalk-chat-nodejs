import { describe, expect, it } from "vitest";

import { parsePhone } from "../src/phone.js";

describe("parsePhone", () => {
  it.each([
    ["+1 555 010 0142", "15550100142"],
    ["(555) 010-0142", "5550100142"],
    ["555.010.0142", "5550100142"],
    ["  +44 20 7946 0958  ", "442079460958"],
    ["1234567", "1234567"],
    ["123456789012345", "123456789012345"],
  ])("accepts %s", (input, digits) => {
    expect(parsePhone(input)).toEqual({ display: input.trim(), digits });
  });

  it.each([
    ["too few digits", "123456"],
    ["too many digits", "1234567890123456"],
    ["letters", "555-CALL-NOW"],
    ["a plus in the middle", "555+0100142"],
    ["empty", ""],
    ["only spaces", "   "],
    ["only separators", "+ - ( )"],
    ["an extension marker", "5550100142 ext 5"],
  ])("rejects %s", (_label, input) => {
    expect(parsePhone(input)).toBeNull();
  });
});
