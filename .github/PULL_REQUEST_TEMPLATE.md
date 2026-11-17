## What and why

<!-- What changed, and why. Link the issue if there is one. -->

## How to test

<!-- Commands to run, or what to click. -->

## What I did not run

<!-- Be plain about anything you could not check (Docker, a browser, a load test). -->

## Checklist

- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm lint:boundaries` and `pnpm test` pass
- [ ] New behaviour has a test; a new endpoint is in the conformance suite and in OpenAPI with its error codes
- [ ] A rule both apps need is in `packages/core`, not copied
- [ ] Docs updated if behaviour or a decision changed (`docs/API.md`, an ADR, `docs/edge-cases.md`)
- [ ] Commits follow Conventional Commits with an allowed scope
- [ ] No secrets, `.env` files or generated files
