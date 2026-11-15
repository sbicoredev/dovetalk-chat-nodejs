import { createHttpHarness, parseAreas } from "./http.harness";
import { runApiConformance } from "./suite";

// Runs the shared suite against a live API. Not part of `pnpm test`, because it needs a server:
//
//   CONFORMANCE_BASE_URL=http://localhost:3001 pnpm --filter @dovetalk/web test:conformance
//
// Optional: CONFORMANCE_WS_URL (socket.io server) and CONFORMANCE_AREAS ("all", or a comma
// separated list such as "auth,profile"). The server needs the demo account (pnpm db:seed) and
// raised RATE_LIMIT_* limits, because every test signs up its own account. The `bots` area also
// needs the worker running against the same Redis and database (docker compose --profile app up
// -d api worker), because the worker is what makes the bots answer: leave that area out with
// CONFORMANCE_AREAS if there is none.
const baseUrl = process.env.CONFORMANCE_BASE_URL?.trim();
if (!baseUrl) {
  throw new Error(
    "Set CONFORMANCE_BASE_URL to the API to test, for example http://localhost:3001.",
  );
}

runApiConformance(
  createHttpHarness({
    baseUrl,
    wsUrl: process.env.CONFORMANCE_WS_URL?.trim() || undefined,
    areas: parseAreas(process.env.CONFORMANCE_AREAS),
  }),
);
