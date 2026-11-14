import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ERROR_CODES,
  ERROR_STATUS,
  isErrorCode,
  MESSAGE_PAGE_MAX,
  MESSAGE_PAGE_SIZE,
  PIN_LIMIT,
  SERVER_EVENT_NAMES,
  SYSTEM_SENDER,
} from "../src/index.js";

const apiDoc = readFileSync(new URL("../../../docs/API.md", import.meta.url), "utf8");

describe("error codes", () => {
  it("lists every code once", () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it("agrees with the status table in docs/API.md", () => {
    // Rows look like: | 404 | `CHAT_NOT_FOUND`, `CONTACT_NOT_FOUND` | Missing resource. |
    const rows = [...apiDoc.matchAll(/^\|\s*(\d{3})\s*\|\s*([^|]+)\|/gmu)];
    const documented = rows.flatMap(([, status, codes]) =>
      [...codes!.matchAll(/`([A-Z_]+)`/gu)].map(([, code]) => [code!, Number(status)] as const),
    );
    expect(documented.length).toBeGreaterThan(10);
    for (const [code, status] of documented) {
      expect(ERROR_STATUS[code as keyof typeof ERROR_STATUS], code).toBe(status);
    }
  });

  it("recognises codes", () => {
    expect(isErrorCode("PIN_LIMIT")).toBe(true);
    expect(isErrorCode("toString")).toBe(false);
    expect(isErrorCode(42)).toBe(false);
  });
});

describe("constants and shared values", () => {
  it("keeps the page size inside the page maximum", () => {
    expect(MESSAGE_PAGE_SIZE).toBeLessThanOrEqual(MESSAGE_PAGE_MAX);
    expect(PIN_LIMIT).toBe(3);
  });

  it("exports the system sender and every server event name", () => {
    expect(SYSTEM_SENDER).toBe("system");
    expect(SERVER_EVENT_NAMES).toContain("message:new");
  });
});
