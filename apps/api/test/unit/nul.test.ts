import { describe, expect, it } from "vitest";

import { containsNul } from "../../src/common/validation.js";

describe("containsNul", () => {
  it("finds a NUL in a string, at any depth, in arrays and in keys", () => {
    expect(containsNul("a\u0000b")).toBe(true);
    expect(containsNul({ name: "a\u0000" })).toBe(true);
    expect(containsNul({ a: { b: [1, { c: "\u0000" }] } })).toBe(true);
    expect(containsNul({ "k\u0000": 1 })).toBe(true);
    expect(containsNul(["fine", ["\u0000"]])).toBe(true);
  });

  it("lets ordinary values through, including other control characters and the text 'u0000'", () => {
    expect(containsNul({ a: "tab\there", b: "line\nbreak", c: "\\u0000", d: "u0000" })).toBe(false);
    expect(containsNul({ a: null, b: 1, c: true, d: [], e: {} })).toBe(false);
    expect(containsNul(undefined)).toBe(false);
  });

  it("does not overflow the stack on a deeply nested value", () => {
    let deep: unknown = "\u0000";
    for (let i = 0; i < 200_000; i += 1) {
      deep = [deep];
    }
    expect(containsNul(deep)).toBe(true);
    let clean: unknown = "x";
    for (let i = 0; i < 200_000; i += 1) {
      clean = { a: clean };
    }
    expect(containsNul(clean)).toBe(false);
  });
});
