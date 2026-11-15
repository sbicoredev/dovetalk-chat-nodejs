import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests: real browsers against the whole stack (web, API, worker, Postgres, Redis,
 * storage). Start it first with `docker compose --profile app up -d --build`, then run
 * `pnpm --filter @dovetalk/web test:e2e`. The web app must be the real-API build, which the
 * Compose `web` service is.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  // The tests share one stack but each signs up its own people, so they could run in parallel.
  // One at a time keeps failures readable and the bots' replies from competing.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: process.env.E2E_CHROMIUM_PATH
      ? { executablePath: process.env.E2E_CHROMIUM_PATH }
      : {},
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
