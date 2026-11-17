# 0013. Scale out behind nginx, with no sticky sessions

- Status: accepted
- Date: 2026-11-17

## Context

The API should be shown to scale horizontally: several instances behind one address, workers
scaled on their own, and measured numbers. The measurements are in [docs/scaling.md](../scaling.md).

## Decisions

**No sticky sessions, and nothing in the balancer's config that implies them.** Sockets are WebSocket only
(ADR 0009), so a connection is one TCP stream that stays on the replica it was opened on, and REST requests
carry a token. No request ever needs "the replica I used last time". The balancer is `least_conn` because
WebSockets live for hours and round-robin would drift out of balance as people come and go.

**nginx, with passive health checks only.** `max_fails=2 fail_timeout=5s` skips a replica that refuses
connections, and `proxy_next_upstream` tries another one for requests that are safe to repeat. nginx
open source has no active health checks, and the API already fails readiness while it shuts down (so a
graceful stop drains first). The cost is that a replica that is up but sick keeps getting requests; the
price of a crash is the connect timeout (2 s) once per client.

**The `scale` profile is separate services, not `--scale api=3`.** `scale-api` and `scale-worker` reuse the
`api` and `worker` definitions through YAML anchors and add the `scale` profile, replicas, and a published
port range (3101-3103) so a test can talk to one replica. The `app` profile publishes the fixed port
3001, which cannot be shared by replicas, and changing it would risk the profile the end-to-end and
conformance jobs use. The cost is two more service names to know.

**nginx resolves `scale-api` once, when it starts.** Replicas that appear later are seen after
`docker compose restart lb`. A `resolver` with a variable `proxy_pass` would follow DNS, but it gives up
`least_conn` and passive checks, which matter more here.

**The cross-instance test aims at replicas, the chaos test at the balancer.** Through nginx there is no way to
know which replica holds a socket, so "sender and receiver on different instances" could only be probable.
Going to the published replica ports makes it certain. A replica can only be killed meaningfully behind the
balancer, because clients on a fixed address cannot move.

**Counting loss as the web app would.** A socket that is down misses events, and the contract is that
clients refetch after reconnecting. The harness reports "lost live" and "lost after resync" apart, and only
the second must be zero when a replica is killed. With no chaos both must be zero.

**One small optimisation, because the profile pointed at it.** The profile showed SQL round trips, not any query,
as the cost. Two provably redundant ones were removed (reactions of a just-stored message, a two-step bot
lookup). It moved CPU per message by 2 to 4%, within noise, and is kept because it is correct and costs
nothing. The larger change, handing the send transaction's context to the fan-out, is a follow-up.

## Alternatives considered

- **ip_hash or sticky cookies.** Needed only for long-polling, which was removed on purpose.
- **Traefik or Envoy.** More features (active checks, DNS-following) and more to learn for a three-line need.
  nginx is what most readers know.
- **Artillery's socket.io engine for the socket test.** It would have replaced the harness's pairing, loss
  counting and resync with its own scenarios. A 600-line script that does exactly the measurement was
  clearer than configuring a framework to approximate it.
- **Tuning Postgres and the pool.** No evidence: Postgres was at about 10% CPU and the pool never ran dry.

## Consequences

- The numbers in docs/scaling.md come from a plain-process stack and a Node balancer on one 2-core machine.
  The Compose profile, nginx, k6 and the CI workflow were written without being run. The first person to
  start the profile should expect to fix something small. (CI will say.)
- Rate limits are off in the `scale` profile. It must never be exposed.
- Telemetry was off in every measurement. Turning it on costs 1.3 to 1.5x the API's CPU (ADR 0012), which
  moves every number above.
