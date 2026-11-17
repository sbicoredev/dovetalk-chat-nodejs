import { defineConfig } from "vitest/config";

// Workspace packages export a "@dovetalk/source" condition that points at their TypeScript
// source, so tests run without building them first.
const conditions = ["@dovetalk/source"];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions, externalConditions: conditions } },
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 20_000,
    // Each worker gets its own Redis database and a package has five (see createTestRedis).
    maxWorkers: 5,
  },
});
