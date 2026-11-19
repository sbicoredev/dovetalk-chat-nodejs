# 0018. Turborepo for tasks, caching and Docker builds

- Status: accepted
- Date: 2026-11-18
- Amends: [0006](0006-esm-and-internal-package-builds.md) (how packages are built and ordered)

## Context

The repository was a pnpm workspace that ran `pnpm -r <script>`. Nothing was cached, so CI and local runs
rebuilt and retested everything every time. The order between packages was written by hand in several
places (`pnpm -r --filter "...^..." build &&` in the `dev` scripts, `pnpm --filter @dovetalk/contracts build &&`
in the web scripts), and Biome and dependency-cruiser ran outside any task graph.

## Decision

- Turborepo runs `build`, `typecheck`, `test`, `test:coverage`, `dev` and `db:seed`. Biome and
  dependency-cruiser are root tasks (`//#lint:biome`, `//#lint:boundaries`), so they are cached too.
  `pnpm lint`, `pnpm test` and the other root scripts keep their names.
- Ordering is declared once, as `dependsOn: ["^build"]`. The per-package `pnpm --filter ... build` prefixes
  are gone from the `dev`, `build`, `db:generate`, `db:migrate` and `db:seed` scripts.
- `typecheck`, `test` and lint also depend on `^build`. tsc and Vitest do not need `dist/` (they resolve the
  `@dovetalk/source` condition), but Turborepo's cache key for a task only covers the package's own files
  and the tasks it depends on. Without the dependency, editing `core` would not invalidate the cached tests
  of `api`. Biome does need `dist/` to resolve `@dovetalk/*` imports, so its task depends on the library builds.
- Environment variables use strict mode. A variable reaches a task only if it is declared:
  `TEST_*` for tests, `NEXT_PUBLIC_*`, `API_PROXY_TARGET` and `NEXT_STANDALONE` for the web build (they are
  baked into the output, so they are part of its cache key), everything for `dev` and `db:seed` (not cached),
  and Docker, testcontainers and CI variables for all tasks. Add a new variable to `turbo.json` when code
  starts reading it, or the task will not see it.
- `apps/web/turbo.json` owns the Next.js outputs (`.next/**`); the services' `dev` task builds the app first.
- The Docker images run `turbo prune @dovetalk/<app> --docker`, install from the pruned lockfile, and build
  with `turbo run build --filter=@dovetalk/<app>`, then `pnpm deploy --prod` as before. The dependency layer
  is rebuilt only when a `package.json` or the lockfile changes. `turbo prune` does not copy
  `tsconfig.base.json`, so the Dockerfiles copy it themselves. The Turborepo version in the Dockerfiles must
  match the root `package.json`.
- CI uses one setup action (`.github/actions/setup`: pnpm, Node, install, local Turborepo cache). Pull requests
  run `--affected`; pushes to `main` run everything and ignore cached test results, because the tests depend
  on Postgres, Redis and S3 images that the cache key does not include. A remote cache turns on when
  `TURBO_TOKEN` and `TURBO_TEAM` are set.
- TypeScript: `noImplicitOverride`, `noImplicitReturns`, `allowUnreachableCode: false`,
  `allowUnusedLabels: false` and `verbatimModuleSyntax` are on, in the base config and in the web app.
  They cost no code changes. Decorator metadata is still emitted (checked in `dist/`).

- Local development builds no image. `pnpm dev` (`ops/scripts/dev.mjs`) makes the missing env files, starts only
  the Compose services that use published images (Postgres, Redis, S3), migrates, seeds on first use, then runs
  `turbo run dev build:watch`. `build:watch` is `tsc --watch` per package, a persistent task that starts after the
  package's first build; the services' `node --watch` restarts on the new `dist/`. The packages cannot be run from
  source because Nest needs decorator metadata, which Node's type stripping does not emit.

## Not adopted yet

`noUncheckedIndexedAccess` (90 errors), `exactOptionalPropertyTypes` (36) and
`noPropertyAccessFromIndexSignature` (134) would need many edits that can change behaviour, so they should
come in their own changes, one flag at a time. Unused variables and parameters stay with Biome.

## Alternatives considered

Nx (more to learn and configure for six packages), keeping `pnpm -r` with a GitHub Actions cache (caches
installs, not task results, and does not know what a change affects), and `pnpm deploy` without `turbo prune`
(works, but every source change invalidates the install layer in the image build).

## Consequences

Docker builds no longer use `pnpm fetch` and an offline install, so the install step needs the network
(the BuildKit cache mount keeps it fast). Everyday commands do not change, and a second `pnpm build` or
`pnpm lint` with nothing edited is served from the cache.
