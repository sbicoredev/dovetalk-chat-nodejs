#!/usr/bin/env node
// One command for local development, with nothing built into a Docker image:
//
//   pnpm dev
//
// 1. Makes the env files you do not have yet from their .env.example (never overwrites one).
// 2. Starts Postgres, Redis and S3 storage from their published images (`docker compose up -d --wait`).
// 3. Applies the migrations, and seeds the demo account the first time.
// 4. Runs the API, the worker and the web app, and recompiles the packages on every save.
//
// Flags:  --no-infra       do not start the services (you run Postgres, Redis and S3 yourself)
//         --skip-migrate   do not apply migrations (faster restarts when the schema did not change)
//         --seed           seed the demo account even when the env files already existed
//         --mock-web       leave the web app on its in-browser mock server instead of the real API

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const flags = new Set(process.argv.slice(2));
const shell = process.platform === "win32";

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", shell });
  if (result.error?.code === "ENOENT") {
    console.error(`\n"${command}" was not found. Install it and try again.`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`\n"${[command, ...args].join(" ")}" failed (exit ${result.status}).`);
    process.exit(result.status ?? 1);
  }
}

/** Copies `example` to `target` unless `target` exists. `edit` may change the text. Returns true if it made the file. */
function ensureFile(target, example, edit = (text) => text) {
  const to = join(root, target);
  if (existsSync(to)) {
    return false;
  }
  const text = readFileSync(join(root, example), "utf8");
  writeFileSync(to, edit(text));
  console.log(`Made ${target} from ${example}`);
  return true;
}

/** Sets `KEY=value` on the line that starts with KEY= (or, failing that, appends it). */
function setVar(text, key, value) {
  const line = new RegExp(`^${key}=.*$`, "mu");
  return line.test(text)
    ? text.replace(line, `${key}=${value}`)
    : `${text.trimEnd()}\n${key}=${value}\n`;
}

const realApi = !flags.has("--mock-web");

// 1. Env files. The API settings below are the ones the web app's /api proxy needs (README).
const madeRootEnv = ensureFile(".env", ".env.example");
const madeApiEnv = ensureFile("apps/api/.env", "apps/api/.env.example", (text) =>
  realApi ? setVar(setVar(text, "COOKIE_PATH", "/api/auth"), "TRUST_PROXY", "1") : text,
);
const madeWorkerEnv = ensureFile("apps/worker/.env", "apps/worker/.env.example");
if (realApi) {
  ensureFile("apps/web/.env.local", "apps/web/.env.example", (text) =>
    setVar(
      setVar(
        setVar(text, "NEXT_PUBLIC_API_URL", "/api"),
        "NEXT_PUBLIC_WS_URL",
        "http://localhost:3001",
      ),
      "API_PROXY_TARGET",
      "http://localhost:3001",
    ),
  );
  const apiEnv = readFileSync(join(root, "apps/api/.env"), "utf8");
  if (!/^COOKIE_PATH=\/api\/auth\s*$/mu.test(apiEnv)) {
    console.warn(
      "\nNote: apps/api/.env does not set COOKIE_PATH=/api/auth, so sign-in will not survive a reload\n" +
        "through the web app's /api proxy. Set it (and TRUST_PROXY=1), or run with --mock-web.\n",
    );
  }
}

// 2. Services: published images only, so there is nothing to build.
if (!flags.has("--no-infra")) {
  run("docker", ["compose", "up", "-d", "--wait", "postgres", "redis", "s3"]);
}

// 3. Database.
if (!flags.has("--skip-migrate")) {
  run("pnpm", ["db:migrate"]);
}
if (flags.has("--seed") || madeApiEnv || madeRootEnv || madeWorkerEnv) {
  run("pnpm", ["db:seed"]);
}

// 4. The apps. `build` runs once for each package (cached), then tsc --watch keeps dist/ current and
// `node --watch` restarts on every change. Turborepo needs room for all the long-running tasks.
console.log(
  "\nStarting the API (:3001), the worker (:3002) and the web app (:3000). Ctrl+C stops them.\n",
);
const apps = spawn("pnpm", ["dev:apps"], { cwd: root, stdio: "inherit", shell });
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => apps.kill(signal));
}
apps.on("exit", (code) => process.exit(code ?? 0));
