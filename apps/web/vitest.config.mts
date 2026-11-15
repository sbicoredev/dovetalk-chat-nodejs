import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    conditions: ["@dovetalk/source"],
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Needs a running API. Run it with `pnpm test:conformance`.
    exclude: [...configDefaults.exclude, "src/lib/api/conformance/http.conformance.test.ts"],
    restoreMocks: true,
  },
});
