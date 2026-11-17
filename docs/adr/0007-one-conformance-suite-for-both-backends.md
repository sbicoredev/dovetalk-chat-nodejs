# 0007. One conformance suite for both backends

- Status: accepted
- Date: 2026-11-13

## Context

The web app can run on an in-browser mock or on the real API. The mock's tests are the executable
spec (docs/API.md says so), so the real API has to behave the way they say. Two copies of the same
tests would drift, and a hand-written list of "what the API should do" would not be checked by
anything.

## Decision

- The mock's behaviour tests are one function, `runApiConformance(harness)`, in
  `apps/web/src/lib/api/conformance/suite.ts`. A harness supplies the parts that differ: a signed-in
  session on a fresh account, a client with no credentials, a way to wait, and a few numbers.
- There are two harnesses. The mock one runs on every `pnpm test` with a fake clock. The HTTP one
  uses the web app's own `createHttpApi` and socket client against `CONFORMANCE_BASE_URL`, so the
  client code is tested together with the server.
- The suite lives in the web app because it tests the web app's `Api` interface. The web app may
  only import contracts, so the suite imports nothing from the backend.
- Tests find ids through the API (a contact by name, a chat through the list) and never write
  `c1` or `chat-c1`.
- Each test signs up a new account on the real API, so tests cannot see each other's changes. The
  suite is grouped into areas. A target lists the areas it implements and the rest are skipped, so
  the output shows how much of the contract is built. Enabling an area is part of the change that
  builds it.
- Tests about how one backend is built (saving between visits, silence while disconnected) stay in
  that backend's own tests.
- The HTTP run has its own Vitest config, in Node and not jsdom, and is not part of `pnpm test`,
  because it needs a server. CI starts the Compose stack and runs it.

## Consequences

- Rate limits must be raised for a conformance run. The harness says so when sign-up answers 429.
- Before the web app had `auth.register`, the harness signed up with one hand-written
  request.
- The seed data (14 contacts, long and short chats, pinned and archived ones) is part of the spec.
  The real API has to give every new account the same shape.
