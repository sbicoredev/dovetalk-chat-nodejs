# Multi-instance scale-out and load tests

## Goal

Show that the system scales horizontally and record measured numbers: several API instances
behind a balancer, workers scaled on their own, load scripts, a chaos run, the bottlenecks they reveal, and
`docs/scaling.md`.

## What changed

- **`ops/loadtest` (new workspace package).** `provision.ts` makes pairs of accounts with a direct chat.
  `ws-fanout.ts` is the socket harness: one person sends over REST, the other listens; it counts lost and
  duplicated messages (live, and after a history resync like the web app does), measures send-to-receive
  latency, server CPU per message and memory per socket, and runs a command mid-test (`--chaos-cmd`).
  `k6/rest.js` is the REST scenario with thresholds. `sweep.sh` runs several rates, `profile-summary.ts` turns
  `--cpu-prof` files into a table, `native/` runs the stack without Docker (processes plus a small balancer),
  `chaos/kill-api.sh` kills a replica of the Compose profile.
- **Compose `scale` profile and `ops/docker/nginx.conf`.** nginx (WebSocket upgrade, `least_conn`, passive
  health checks, no sticky sessions), 3 `scale-api` replicas published on 3101-3103, 2 `scale-worker` replicas.
  The API's environment became a YAML anchor so both profiles share it.
- **`perf(core)`.** Two redundant SQL round trips per send removed (reactions of a just-stored message; the bot
  lookup is one query). 2 to 4% less CPU per message, inside the noise. Honest, small.
- **CI.** `loadtest.yml` (PRs that touch the API, core, db, worker or the load tools; manual full run) and two
  checks in `compose-config` (`config -q` for the profile, `nginx -t`). dependency-cruiser keeps the load tools
  to the contracts package.
- **Docs.** `docs/scaling.md`, ADR 0013, README.

## Results (details and caveats in docs/scaling.md)

On a 2-core machine that also ran the generator, Postgres, Redis and the balancer:

- 5,000 sockets over 3 API instances, every message crossing Redis: 0 lost, 0 duplicated, p50 10 ms, p99 38 ms
  at 50 msg/s. 3,000 sockets at 75 msg/s: p99 47 ms.
- One of three instances SIGKILLed mid-run: 666 clients moved, all reconnected and caught up in 4.0 s, 29 messages
  missed live and all 29 recovered, 0 lost, 0 duplicated.
- The knee is about 200 msg/s on those two cores. At 250 msg/s p50 was 5.2 s and nothing was lost.
- The CPU of the Node processes limits, not Postgres (10% at the knee). `GET /chats` runs in 0.34 ms. No
  index was added.

## NOT run (read this)

The build environment had no Docker daemon, no nginx and no k6. So: the Compose `scale` profile resolves
(`docker compose config`) but nothing was built or started; `nginx.conf` was never loaded by nginx; the k6 script
was only syntax-checked; the new CI workflow and `kill-api.sh` never ran. The numbers come from the real API
and worker as plain processes, Postgres 16 and Redis 7, with a Node balancer standing in for nginx. Expect a
small fix when the profile is first started; CI is the first check.

## How to test

```bash
pnpm install --frozen-lockfile && pnpm --filter "./packages/*" build
pnpm lint && pnpm lint:boundaries && pnpm typecheck
pnpm --filter @dovetalk/loadtest test
docker compose --profile scale up -d --build        # then the commands in docs/scaling.md
```

## Checklist

- [x] Profile `scale` written: nginx, 3 API, 2 workers, no sticky sessions (stated in the docs). **Not started.**
- [x] k6 REST scenarios written with thresholds. **Not run.**
- [x] Node harness: 5,000 sockets reached (the target was 2,000 to 5,000), paired across instances, p50/p95/p99,
      lost and duplicated (zero), memory per socket (about 15 KB server side).
- [x] Chaos run: instance killed mid-test, clients reconnect and resync, recovery time recorded (4.0 s). Done
      through the Node balancer, not nginx.
- [x] Bottlenecks found with evidence, each fix its own commit with numbers: one small fix, no index or pool
      change because the evidence did not support one. The larger fan-out change is a follow-up.
- [x] `docs/scaling.md` with hardware, versions, date, stateless/stateful, 10x and 100x, "indicative" caveat.
- [x] CI load-test smoke on PRs touching the API. **Never ran.**
- [ ] "Grafana screenshots committed to docs/": **not done** (no Grafana, and telemetry was off during the runs).
      The results are JSON and tables in docs/scaling.md instead.
