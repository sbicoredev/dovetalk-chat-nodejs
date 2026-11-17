# 0006. ESM, and how internal packages are built

- Status: accepted
- Date: 2026-11-13

## Context

Nest 12 ships ESM only. Four consumers must work with the shared packages: the Nest apps at runtime,
Vitest, Next.js, and the Docker images.

## Decision

- Everything on the backend is ESM: `"type": "module"`, `module: nodenext`, relative imports end in `.js`.
- Each package compiles with `tsc` (TypeScript 7) to `dist/` with declarations. There is no bundler, so
  nothing strips decorator metadata. TypeScript 7 emits `design:paramtypes` the same way 6 does, which
  was checked.
- Each package's `exports` has three conditions in order: `@dovetalk/source` (the `.ts` source), `types`,
  `default` (`dist`). `tsc` (via `customConditions`) and Vitest (via `resolve.conditions`) ask for the
  source condition, so typecheck and tests need no prior build. Node, Next and Docker use `dist`.
- `pnpm build` builds in dependency order. The web `dev` and `build` scripts build `contracts` first.
- Docker images use `pnpm deploy --prod`, which copies the compiled app and the compiled packages it
  needs, with production dependencies only.
- Tests use Vitest alone. `unplugin-swc` is not needed: Vite 8's transformer emits decorator metadata,
  and dependency injection by constructor type works in tests (checked on a Nest 12 scaffold).

## Alternatives considered

`tsup` or `esbuild` (no decorator metadata, so every injection would need an explicit `@Inject()`),
SWC (an extra compiler for no gain), TypeScript project references (fights with `customConditions`),
and source-only packages (Node cannot run `.ts` from `node_modules` inside an image).

## Consequences

A package edit needs `pnpm build` before running an app with `node`, but not before tests or typecheck.
