"use strict";
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "api-and-worker-are-separate",
      comment:
        "The API and the worker deploy and scale on their own. Shared code belongs in packages/. See docs/adr/0001.",
      severity: "error",
      from: { path: "^apps/api/" },
      to: { path: "^apps/worker/" },
    },
    {
      name: "worker-does-not-import-api",
      comment: "Same rule, the other direction.",
      severity: "error",
      from: { path: "^apps/worker/" },
      to: { path: "^apps/(api|web)/" },
    },
    {
      name: "loadtest-talks-to-the-api-over-the-network",
      comment:
        "The load tests are a client like any other: they may share the contracts package and nothing else in the workspace, so they cannot take a shortcut the real clients cannot.",
      severity: "error",
      from: { path: "^ops/loadtest/" },
      to: { path: "^(apps|packages/(?!contracts/))" },
    },
    {
      name: "web-is-a-leaf",
      comment:
        "The web app talks to the backend over HTTP and may only share the contracts package.",
      severity: "error",
      from: { path: "^apps/web/" },
      to: { path: "^(apps/(api|worker)|packages/(core|db|testkit))/" },
    },
    {
      name: "packages-do-not-import-apps",
      comment: "Dependencies point one way: apps depend on packages.",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "contracts-is-a-leaf",
      comment: "contracts is shared with the browser, so it imports nothing from the workspace.",
      severity: "error",
      from: { path: "^packages/contracts/" },
      to: { path: "^packages/(?!contracts/)" },
    },
    {
      name: "telemetry-is-a-leaf",
      comment:
        "telemetry is loaded before everything else (node --import ./dist/instrumentation.js), by both apps and by core, so it imports nothing from the workspace.",
      severity: "error",
      from: { path: "^packages/telemetry/" },
      to: { path: "^(apps|packages)/(?!telemetry/)" },
    },
    {
      name: "db-only-needs-contracts",
      comment: "db may use contracts and nothing else in the workspace.",
      severity: "error",
      from: { path: "^packages/db/src/" },
      to: { path: "^packages/(?!(db|contracts)/)" },
    },
    {
      name: "core-layering",
      comment: "core builds on db, contracts and telemetry only.",
      severity: "error",
      from: { path: "^packages/core/src/" },
      to: { path: "^packages/(?!(core|db|contracts|telemetry)/)" },
    },
    {
      name: "testkit-only-in-tests",
      comment: "testkit starts containers and drops databases. It must never ship in app code.",
      severity: "error",
      from: { path: "^(apps|packages)/[^/]+/src/", pathNot: "\\.test\\.ts$" },
      to: { path: "^packages/testkit/" },
    },
    {
      name: "no-circular",
      comment:
        "Import cycles are errors. The one exception is users.ts and attachments.ts in the db schema: a user points at its profile photo and an attachment at its owner. Every reference is a lazy arrow function (see the Biome ignore in both files), and Drizzle has no way to declare a foreign key without importing the table it points at.",
      severity: "error",
      from: { pathNot: "^packages/db/src/schema/(users|attachments)\\.ts$" },
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(dist|\\.next|coverage)/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["@dovetalk/source", "import", "node", "default", "types"],
      mainFields: ["module", "main", "types"],
    },
  },
};
