# Contributing

Thanks for looking. This file covers setting up, the checks a change has to pass, how commits and pull requests
are written, and where things live. If something here is wrong or missing, fixing it is a good first contribution.

## Set up

You need Node 26 (see `.nvmrc`), pnpm 12 and Docker. Docker runs Postgres, Redis and the S3-compatible
store only; the apps run on your machine.

```bash
nvm use                                  # Node 26
npm install --global pnpm@12.21.0
pnpm install
pnpm dev
```

`pnpm dev` is the whole loop, and it builds no Docker image:

1. It makes `.env`, `apps/api/.env`, `apps/worker/.env` and `apps/web/.env.local` from their examples if they are
   missing (it never overwrites one), with the API settings the web app's `/api` proxy needs.
2. It starts Postgres, Redis and S3-compatible storage from their published images.
3. It applies the migrations, and seeds `demo@dovetalk.app` / `dovetalk123` the first time.
4. It runs the API (<http://localhost:3001/docs>), the worker and the web app (<http://localhost:3000>). The packages
   recompile as you save (`tsc --watch`) and the Node apps restart on the new output; the web app hot-reloads.

Flags: `pnpm dev --no-infra` (you run Postgres, Redis and S3 yourself), `--skip-migrate`, `--seed`, and `--mock-web`
(leave the web app on its in-browser mock server). `pnpm dev:infra` and `pnpm dev:down` start and stop the three
services alone, and `pnpm dev:apps` runs only the apps.

The Compose `app` profile builds the three Dockerfiles. It is for checking the images and for running the
conformance and end-to-end suites, not for everyday work.

## Checks

A change is ready when all of these pass. CI runs the same ones.

```bash
pnpm lint                # Biome (lint, format, import order) and the dependency boundaries
pnpm typecheck
pnpm lint:boundaries     # the API and the worker must not import each other
pnpm test                # unit and integration tests
pnpm test:coverage       # the same, with coverage reports in each package's coverage/
```

- Integration tests need Postgres, Redis and an S3-compatible server. Set `TEST_DATABASE_URL`,
  `TEST_REDIS_URL` and `TEST_S3_ENDPOINT` to ones you already run, or start Docker and Testcontainers starts
  them for you.
- `pnpm --filter @dovetalk/web test:conformance` runs the shared behaviour suite against a live API
  (`CONFORMANCE_BASE_URL`), with the worker running. The same suite runs against the in-browser mock on every
  `pnpm test`. When you build a new endpoint, enable its area in `IMPLEMENTED_AREAS`
  (`apps/web/src/lib/api/conformance/http.harness.ts`) in the same change. See
  [ADR 0007](docs/adr/0007-one-conformance-suite-for-both-backends.md).
- `pnpm --filter @dovetalk/web test:e2e` runs Playwright against the Compose stack.
- `pnpm format` applies Biome's fixes. Do not run `biome check --write --unsafe` over the repository and do not
  turn `useSortedPackageJson` on; both are explained in
  [ADR 0008](docs/adr/0008-biome-over-eslint-prettier.md). Biome does not format Markdown.
- If you change the database schema, generate a migration (`pnpm --filter @dovetalk/db db:generate`), commit it with
  its snapshot, and update the ER diagram: `node ops/scripts/gen-er-diagram.mjs`, pasted into
  [docs/architecture.md](docs/architecture.md). CI checks it with `--check`.
- If you edit a Mermaid diagram, `node ops/scripts/check-mermaid.mjs` checks the syntax of every one.

## Where things live

| Path | What |
| --- | --- |
| `apps/api` | HTTP and socket.io: controllers, auth, the gateway, DTO validation |
| `apps/worker` | Background jobs: bot replies, cleanup |
| `packages/core` | Business rules, used by **both** apps. A rule has one implementation, here |
| `packages/db` | Drizzle schema, migrations, client |
| `packages/contracts` | DTO types, error codes, shared constants |
| `apps/web` | The Next.js client, and the conformance suite |

The API and the worker never import each other. If both need something, it goes in `packages/core`
([ADR 0001](docs/adr/0001-two-deployables-shared-libraries.md)). Decisions with reasons are in
[docs/adr](docs/adr); diagrams are in [docs/architecture.md](docs/architecture.md); gaps and judgement calls are
in [docs/edge-cases.md](docs/edge-cases.md). Add a record when you make a decision someone will later ask about.

## Dependencies

Use the latest stable release of everything: no alpha, beta, rc or canary, and pinned major tags for Docker images,
never `:latest`. If the latest version breaks something we need, pin the newest compatible one and record why in
[ADR 0005](docs/adr/0005-dependency-policy.md). Renovate opens the update pull requests. Biome and Ultracite are
exact-pinned and are upgraded together.

## Commits

[Conventional Commits](https://www.conventionalcommits.org), checked by commitlint. Allowed scopes: `web`, `api`,
`worker`, `core`, `db`, `contracts`, `telemetry`, `ops`, `docs`, `ci`, `deps`.

```
feat(api): add idempotent message send
fix(core): keep paging whole when a hidden message is the cursor
test(api): cover the pin limit
docs: add an ADR for per-viewer projection
```

Keep each commit building and passing the tests that existed at that point, and do not mix a refactor with a
feature. The changelog is generated from these messages, so the subject should say what changed for a reader.

## Releases

Releases are automated by [release-please](https://github.com/googleapis/release-please). On every push to `main`
it reads the Conventional Commit messages and keeps one pull request open that bumps the version in
`package.json` and adds the new entries to [CHANGELOG.md](CHANGELOG.md). Merging that pull request creates the
tag and the GitHub release. `feat` raises the minor version, `fix` and `perf` the patch version, and a `!` or a
`BREAKING CHANGE:` footer the major version.

The first release is pinned to `1.0.0` by `release-as` in `release-please-config.json`. **Remove that line after
`v1.0.0` is out**, or every later release will try to stay at 1.0.0.

## Pull requests

Branch from `main`, keep the pull request to one change, and rebase on `main` before asking for review. The
description says what changed and why, how to test it, and what you did **not** run. The checklist:

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm lint:boundaries` and `pnpm test` pass
- [ ] New behaviour has a test, and a new endpoint is in the conformance suite and in OpenAPI with its error codes
- [ ] A rule that both apps need is in `packages/core`, not copied
- [ ] Docs are updated (`docs/API.md`, an ADR, the edge-case register) if behaviour or a decision changed
- [ ] No secrets, no `.env` files, no generated files

Open issues labelled `good first issue` or `help wanted` are listed in [docs/roadmap.md](docs/roadmap.md).
By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go through
[SECURITY.md](SECURITY.md), not a public issue.

## Turborepo

`build`, `typecheck`, `test`, `test:coverage` and `lint` run through [Turborepo](https://turbo.build) (`turbo.json`,
[ADR 0018](docs/adr/0018-turborepo.md)): tasks run in dependency order, in parallel, and their results are cached in
`.turbo/`. A second `pnpm build` or `pnpm lint` with nothing edited is instant.

- One package: `pnpm turbo run test --filter=@dovetalk/core` (add `...` after the name to include its dependencies).
- Only what your branch touched: `pnpm turbo run typecheck test --affected`. CI does this on pull requests.
- Skip the cache for one run: add `--force`.
- Environment variables are strict: a task sees only the variables `turbo.json` declares. If you make code read a new
  variable, add it there (`env` when it changes the output, `passThroughEnv` when it only configures the run).
- Share the cache across machines by setting `TURBO_TOKEN` and `TURBO_TEAM`; CI uses them when they exist.
