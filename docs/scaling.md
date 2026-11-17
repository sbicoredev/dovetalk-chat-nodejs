# Scaling

How Dovetalk scales out, what was measured, what was found, and what is not known. Read the
["What was and was not run"](#what-was-and-was-not-run) section before quoting any number.

Decisions: [ADR 0013](adr/0013-scale-out-without-sticky-sessions.md). Tools: [ops/loadtest](../ops/loadtest).

## What is stateless and what holds state

| Piece | State | Why that is fine |
| --- | --- | --- |
| API (`apps/api`) | none that another instance needs | A request carries a signed token, so there is no session to find. Events go out through Redis, so whichever instance holds a socket delivers to it. |
| Worker (`apps/worker`) | none | Jobs are in Redis, and each runs once however many workers there are. |
| nginx (`ops/docker/nginx.conf`) | connection table only | WebSocket only, so a connection is one TCP stream on one replica for its life. No `ip_hash`, no sticky cookie. |
| PostgreSQL | **all durable data** | One writer. The only thing that cannot be added to by starting another container. |
| Redis | socket.io adapter channels, presence ZSETs, throttle counters, BullMQ queues | Loss of Redis loses presence (rebuilt by heartbeats), live events (clients refetch on reconnect) and queued jobs (AOF is on in Compose). |
| Object storage (S3 API) | uploaded files | Shared by every replica; browsers fetch by signed URL, not through the API. |

Small per-process memory exists and is safe to lose: the auth guard's user cache (30 s), each socket's typing
bookkeeping, and the realtime fan-out's per-chat lanes (they order one chat's events inside one process).

## Run it

```bash
cp .env.example .env
docker compose --profile scale up -d --build     # nginx :8080, 3 API replicas, 2 workers
# replicas are also published one by one on :3101, :3102, :3103
pnpm install
pnpm --filter @dovetalk/loadtest provision --base-url http://localhost:8080 --pairs 500 --out fixture.json
pnpm --filter @dovetalk/loadtest fanout --strict --fixture fixture.json --pairs 500 \
  --targets http://localhost:3101,http://localhost:3102,http://localhost:3103 --duration 60 --rate 0.1
```

`API_REPLICAS`, `WORKER_REPLICAS` and `API_DIRECT_PORTS` (a range with at least one port per replica) change the
shape. The `scale` profile raises the API's rate limits to ten million, because a load test signs up
thousands of people from one address. **Do not use those defaults on the internet.**

The two ways to aim the fan-out test:

- `--targets a,b,c` goes straight to each replica. Pair *i* sends through replica *i mod k* and listens on
  replica *(i+1) mod k*, so every message has to cross Redis to reach its listener. This is the run that proves
  cross-instance delivery.
- `--base-url http://localhost:8080` goes through nginx, which is the realistic path and the only one on which
  a replica can be killed (`--chaos-cmd "ops/loadtest/chaos/kill-api.sh 2" --chaos-at 20`).

REST: `k6 run -e BASE_URL=http://localhost:8080 -e FIXTURE=fixture.json ops/loadtest/k6/rest.js`.
No Docker? `ops/loadtest/native/stack.sh up` starts the same built code as plain processes, with a small
balancer in nginx's place (this is how the numbers below were made).

## Results

**Hardware and versions.** A 2 vCPU, 8 GB virtual machine (Intel Xeon @ 2.30 GHz, Linux 6.18), **with the
load generator, 3 API processes, 2 workers, Postgres 16.15, Redis 7.0.15 and the balancer all on it**: about
two cores for everything. Node 26.13.1, socket.io 4.8, `@socket.io/redis-adapter` 8.3. Telemetry was **off**
(no OTLP endpoint; with one it costs about 1.3 to 1.5x the API's CPU, ADR 0012). Run on 2026-11-17.
These numbers are indicative, not capacity: see the caveats.

### Fan-out at many sockets, every message crossing instances (`--targets`)

| Sockets | Pairs | Sent | Rate | Lost | Duplicated | p50 | p95 | p99 | Server CPU per message |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,000 | 500 | 7,500 | 250 msg/s | 0 | 0 | 5,208 ms | 9,722 ms | 11,144 ms | not measured (see below) |
| 3,000 | 1,500 | 3,000 | 75 msg/s | 0 | 0 | 10.8 ms | 25.3 ms | 47.4 ms | 5.7 ms |
| **5,000** | 2,500 | 2,001 | 50 msg/s | 0 | 0 | 10.3 ms | 22.0 ms | 38.1 ms | 6.1 ms |

Latency is from the moment the sender's request starts to the moment the listener's socket receives the event,
so it includes the request itself (about 7 to 10 ms at these loads). **5,000 sockets was the most this machine
reached, not a limit found**; all connected, none dropped. Nothing was lost or duplicated at any size, including
the first row, which is overloaded (below).

### Where the knee is (500 pairs = 1,000 sockets, rate swept)

| Offered | p50 | p95 | p99 | Notes |
| ---: | ---: | ---: | ---: | --- |
| 25 msg/s | 10 ms | 20 ms | 34 ms | |
| 50 msg/s | 10 ms | 19 ms | 25 ms | |
| 100 msg/s | 12 to 15 ms | 31 to 45 ms | 73 to 116 ms | two runs per cell, before and after the change below |
| 150 msg/s | 16 ms | 57 ms | 92 ms | |
| 200 msg/s | 29 to 46 ms | 112 to 458 ms | 197 to 857 ms | the tail starts to grow, runs differ a lot |
| 250 msg/s | **5,208 ms** | 9,722 ms | 11,144 ms | saturated: the machine's two cores are the limit |

At 250 msg/s the three APIs together used the whole machine (`top`: about 190% CPU across them, Postgres about
10%), requests queued, and the event arrived a median 4.6 s after the request had been answered. Nothing was
lost, because the fan-out waits its turn instead of dropping. That is the shape to expect: past the knee the
system gets slow, not wrong.

### Chaos: one of three API instances killed with SIGKILL (through the balancer)

2,000 sockets, 100 msg/s, instance 2 killed 15 s into a 40 s run.

| | |
| --- | --- |
| Sockets that had to move | 666 (a third, as expected) |
| Time until every one of them was reconnected **and** had fetched what it missed | **4.0 s** (kill to last resync done) |
| Reconnect alone, p50 / p95 / max | 1.2 s / 1.4 s / 3.0 s |
| Messages not received on the socket (it was down) | 29 of 4,000 |
| Of those, recovered by the history fetch the web app does after reconnecting | 29 |
| **Lost after the resync** | **0** |
| Duplicated | 0 |
| Sends that failed for good | 0 (1 retry, with the same `clientId`) |
| Latency p50 / p99 for the whole run | 13 ms / 1,449 ms (the tail is the 4 s window) |

"Lost live" is not zero in this run and cannot be: a socket that is down hears nothing. The contract's answer
is that clients refetch after reconnecting, and the run does exactly that. With no chaos the live loss is zero
too, as in the table above.

### Cost per connection

On a fresh stack, 5,000 sockets added about **15 KB of resident memory each** on the API side (725 to 799 MB
over three processes, so about 15 KB x 5,000 = 74 MB) and about 27 KB each in the test client. The 3,000-socket
run measured a negative number (RSS fell while the heap was being collected after earlier runs), so one
reading is not a precise figure: read it as "tens of KB, not hundreds". An idle API process is about 250 MB.

### REST on one instance

30 concurrent clients doing `GET /chats` and a history page in a loop: about 420 requests per second, and the
median of each grew to 54 ms and 84 ms, which is queueing at 100% of the CPU the instance can get. With 5
clients, the medians were 10.5 ms and 12.6 ms. The k6 scenario was written but **not run** (no k6 here).

## Bottlenecks found

1. **CPU of the Node processes, not the database.** At the knee the APIs were 190% busy and Postgres 10%.
   `GET /chats` runs in 0.34 ms in the database (`EXPLAIN (ANALYZE, BUFFERS)`: every access is an index scan,
   12 chats, 125 buffers, the lateral join for the last visible message uses `messages_chat_id_seq_key` and
   `message_hidden_pkey`). **No index was added**: the evidence says the indexes that exist are used and the
   database is not what limits.
2. **SQL round trips.** A CPU profile of one instance at the knee (`ops/loadtest/src/profile-summary.ts`)
   put 39% of busy time in socket writes, and 30 of those 39 points were writes to Postgres (`pg`), 6.5 to
   Redis. A send did **17 round trips**: 10 in its transaction (begin, chat and membership, existing
   `clientId`, blocks, `last_seq`, insert, unread, reactions, directory, commit) and 7 after (bot lookup 2, fan-out
   context 5). It does 14 now. Drizzle's query building was another 14%.
3. **What was changed for it** (commit `perf(core): drop two redundant SQL round trips`): no reactions query for
   a message that was just stored (in the transaction and in the fan-out), and one query instead of two for the
   bot lookup that runs after every send. Result: server CPU per message **6.54 to 6.38 ms at 100 msg/s and
   4.90 to 4.73 ms at 200 msg/s**, 2 to 4%, inside the noise of a shared machine. The honest reading is that the
   change is correct and small; the 5 queries the fan-out repeats (message, members, hidden, directories)
   mostly re-read what the send transaction already knew, and passing that context along is the change that
   would matter. It is a bigger edit to `RealtimeEvents` and was not made.
4. **Not touched, on purpose.** The pool (10 per process, 50 connections of Postgres's 100 with 3 APIs and 2
   workers) never ran dry in these runs, so it was not changed; the Collector's cost is ADR 0012's.

## At 10x and 100x

What would change, in the order it would be needed. None of this has been built or measured.

- **10x (tens of thousands of sockets, thousands of messages a second).** More API replicas first (they are the
  CPU). Then fewer round trips per send (item 3 above), and PgBouncer in front of Postgres so a hundred
  processes do not mean a hundred connections. Read replicas for `GET /chats` and history, which are the reads.
  Partition `messages` by `chat_id` hash or by time once it is in the hundreds of millions of rows.
- **100x.** Redis becomes the shared hot spot: every event is a publish, and a publish is delivered to every
  instance that subscribed to that user's room. Move to the sharded Redis adapter (`@socket.io/redis-adapter`
  sharded pub/sub, Redis 7) or the streams adapter, and shard BullMQ queues. A dedicated realtime tier that
  only holds sockets (the API's HTTP and its sockets scale differently: sockets are memory, requests are CPU).
  A CDN in front of uploads. `last_seq` serialises writes per chat, which is fine until one chat is very hot.

## What was and was not run

Said plainly, because the environment this was measured in had no Docker daemon, no nginx and no k6.

**Run, with the numbers above:** the real API (3 processes) and worker (2 processes) from the repository's
build, against real Postgres 16 and Redis 7, driven by the Node harness, through the harness's own
least-connections balancer (`ops/loadtest/native/lb.ts`) for the chaos run and directly for the cross-instance
runs. The core test suite (429 of 431; the 2 failures are upload downloads against a throwaway S3 stand-in).

**Written and checked only statically, never executed:**

- The Compose `scale` profile: `docker compose --profile scale config` resolves (3 API replicas, 2 workers, the
  port range, the raised limits), but no image was built and no container started.
- `ops/docker/nginx.conf` was never loaded by nginx. `nginx -t` runs in CI (`compose-config` job) and has never
  run in GitHub Actions. The image tag `nginx:1.30-alpine` was not pulled (the current stable line is 1.30,
  1.30.6 on 2026-10-14).
- `ops/loadtest/k6/rest.js` passes a syntax check and Biome only. Its thresholds are guesses until it runs.
- `.github/workflows/loadtest.yml` has never run. `ops/loadtest/chaos/kill-api.sh` has never run (the same
  chaos was done with `stack.sh kill-api`, SIGKILL of the process).

**Differences between what was run and what Compose runs:** the balancer (a byte-forwarding Node process, not
nginx), no container networking, no `docker kill`, Postgres 16 instead of 18, Redis 7.0 instead of 8, no object
storage. The application code and the measured paths are the same; the balancer's own cost and behaviour are not.

## Caveats

- One machine hosted everything, including the load generator. The numbers say how the code behaves when it
  has about two cores, not what a real deployment does. The generator's own event loop lag was 10 ms at p50
  (its timer resolution) and 13 to 21 ms at p99, so latencies under about 20 ms are at its measurement floor.
- Runs of 20 to 40 seconds, one run per cell in most tables. Variation between two runs of the same cell was
  large near the knee (p99 197 vs 857 ms at 200 msg/s).
- The chaos run killed an API, not Redis or Postgres, and did not bring the instance back.
- Accounts were created through the real sign-up, so each had the seeded demo data, but chats held only the
  test's own messages (a few dozen), so history pages were short.
- `latency` includes the request itself. A recipient's delay after the sender's request has been answered is
  smaller by that amount.
