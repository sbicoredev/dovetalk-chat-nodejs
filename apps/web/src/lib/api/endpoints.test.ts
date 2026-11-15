import { describe, expect, it } from "vitest";

import { resolveEndpoints } from "./endpoints";

describe("resolveEndpoints", () => {
  it("means the mock when there is no API URL", () => {
    expect(resolveEndpoints("", "")).toBeNull();
    expect(resolveEndpoints("  ", "http://ws.test")).toBeNull();
  });

  it("takes the socket from the origin of an absolute API URL", () => {
    expect(resolveEndpoints("http://localhost:3001/v1", "")).toEqual({
      apiUrl: "http://localhost:3001/v1",
      wsUrl: "http://localhost:3001",
    });
  });

  it("prefers an explicit socket URL", () => {
    expect(resolveEndpoints("http://api.test", "https://ws.test")).toEqual({
      apiUrl: "http://api.test",
      wsUrl: "https://ws.test",
    });
  });

  it("needs the socket URL when the API is a path on this site", () => {
    expect(resolveEndpoints("/api", "http://localhost:3001")).toEqual({
      apiUrl: "/api",
      wsUrl: "http://localhost:3001",
    });
    expect(() => resolveEndpoints("/api", "")).toThrow(/NEXT_PUBLIC_WS_URL/u);
  });
});
