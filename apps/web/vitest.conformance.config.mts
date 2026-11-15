import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// The conformance suite against a live API (see http.conformance.test.ts). It runs in Node, not
// jsdom, so uploads use Node's own FormData and Blob, the way fetch expects them.
export default defineConfig({
  resolve: {
    conditions: ["@dovetalk/source"],
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/lib/api/conformance/http.conformance.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
