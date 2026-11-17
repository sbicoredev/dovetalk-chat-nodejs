# 0005. Dependency policy and recorded exceptions

- Status: accepted
- Date: 2026-11-13, updated 2026-11-17

## Policy

Use the latest stable release of every package, Docker image and tool. No alpha, beta, rc or canary.
Versions are checked against the registry when installed. Docker images use pinned major tags, never
`:latest`. Renovate keeps everything current. If the latest release is incompatible with something we
need, pin the newest compatible version and record the reason here with a way back.

## Where we stand (2026-11-13)

Node 26 (current LTS; inferred from `@types/node` 26 and Node 27 alpha on npm, because nodejs.org was
not reachable), pnpm 12.18, Nest 12.5, TypeScript 7.0, Vitest 5.1, Vite 8, Next 16.4, Zod 4, Drizzle
0.45, BullMQ 6, ioredis 6, Biome 2.6.7 with Ultracite 8.2.0 (see ADR 0008). The frontend's dependencies were already on their latest majors. The upgrade
commit only moved `next` and `lucide-react` by a minor.

## Changes on 2026-11-17

Checked against the registry before the 1.0.0 release:

- Patch and minor updates applied (`@aws-sdk/*`, `@nestjs/swagger`, `jsdom`, `lint-staged`, `postcss`,
  `lucide-react`), and pnpm moved from 12.18.0 to 12.21.0 everywhere it is pinned (`packageManager`, the
  Dockerfiles, CI).
- The GitHub Actions were a major version or more behind: `actions/checkout`, `setup-node` and `upload-artifact` moved
  from v5 to v7, `docker/setup-buildx-action` from v3 to v4 and `docker/build-push-action` from v6 to v7. The
  workflows have **never run on GitHub**, so the first run is the check. New workflows use the same versions
  (`codecov/codecov-action` v7, `github/codeql-action` v4, `lycheeverse/lychee-action` v2).
- **Biome and Ultracite were not updated** (see the exceptions).
- `pnpm audit --prod` reports **no known vulnerabilities**. `pnpm audit` over everything reports three moderate ones,
  all in development tooling (see the exceptions).

## Exceptions

| What                        | Exception                                                                                                                     | Why                                                                                                                                    | Way back                                                                                                                            |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript                  | `tsc` is 7.0.2. The `typescript` package name is aliased to `@typescript/typescript6` (6.0.x) at the root and in the API      | TypeScript 7 ships no programmatic API. `dependency-cruiser` and `@nestjs/swagger` (peer `^5.5 \|\| ^6`) need one | Drop the alias when `dependency-cruiser` and `@nestjs/swagger` work with TypeScript 7                                          |
| Biome and Ultracite | Exact-pinned at `2.6.7` and `8.2.0`, although `2.6.8` and `8.2.1` exist | `2.6.8` reports four `noUnnecessaryConditions` errors in `checkContent` (`packages/core/src/conversations/message-content.ts`), calling every `case` of a switch over the message kind "unreachable". The switch is reachable and the same code is clean on `2.6.7`, so it looks like a type-inference regression, not a finding. `useExhaustiveDependencies` and `noExcessiveCognitiveComplexity` are also warnings in the web app only, until its UI is refactored | Renovate upgrades both together in one PR. Retry on each release: if the four errors are gone, take it. Relax to a range if the churn stays low |
| Local object storage        | SeaweedFS replaces MinIO                                                                                                      | The MinIO community edition stopped shipping images in October 2025 and its repository was archived in April 2026                      | `S3_IMAGE` is one variable. The tag in `.env.example` could not be checked against Docker Hub from the build sandbox, so confirm it |
| HTTP adapter                | `@nestjs/platform-express`, not the new `NodeAdapter`                                                                         | Multer, Helmet and the OpenTelemetry HTTP and Express instrumentation all target Express                                               | Revisit if profiling shows the adapter matters                                                                                      |
| pnpm build scripts          | Denied for `esbuild`, `protobufjs`, `ssh2`, `cpu-features` and `@scarf/scarf`                                                 | None is needed to build or run the apps. `@scarf/scarf` is an analytics beacon                                                         | Allow a package in `pnpm-workspace.yaml` if it ever becomes necessary                                                               |
| Postgres                    | Compose and CI use Postgres 18. Local tests in the build sandbox ran on 16                                                    | No Docker daemon was available there                                                                                                   | CI runs everything on 18                                                                                                            |
| Grafana image               | `grafana/grafana:13.3.1` is **not verified** as the latest release                                                            | Its binaries are on `dl.grafana.com`, which the build sandbox could not reach, and GitHub has no release assets for it. 13.3.1 is the number the task gave | `GRAFANA_IMAGE` is one variable. Check the tag with `docker compose --profile observability pull`, and see [0012](0012-opentelemetry-stack.md) |
| Observability image tags    | The Collector, Tempo, Prometheus, Loki and the two exporters are the latest release assets found on GitHub, but **no tag was checked against a registry** | Docker Hub, quay.io and ghcr.io were not reachable, so that a release exists does not prove an image was published under that tag | Every tag is a variable in `docker-compose.yml`. The first `pull` confirms them, see [0012](0012-opentelemetry-stack.md) |
| Dev-only advisories         | Three moderate advisories are accepted: `esbuild` (through `drizzle-kit` and its deprecated `@esbuild-kit` loader), `glob` (through `testcontainers`) and `minimatch` (through `ultracite` and ESLint) | All three are in development tooling. None is installed in an image or reachable in production, which `pnpm audit --prod` confirms. The fixes need a new major of the parent package | CI audits production dependencies and fails on any finding. Re-run `pnpm audit` when `drizzle-kit`, `testcontainers` or `ultracite` release |
| Licences                    | `@img/sharp-libvips-linux-x64` is LGPL-3.0-or-later; every other production package is permissive (MIT, ISC, Apache-2.0, BSD, 0BSD, PSF, OFL for fonts, CC-BY for data) | It is the prebuilt image library that Next.js loads for image optimisation. It is linked dynamically and not modified | If the licence is ever a problem, replace or drop `sharp` (Next.js falls back to its slower built-in optimiser) |
