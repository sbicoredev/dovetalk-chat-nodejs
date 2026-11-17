import { exec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import os from "node:os";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";

import { io, type Socket } from "socket.io-client";

import type { AuthResult, MessageDto, MessagePage } from "@dovetalk/contracts";

import { Options } from "./args.ts";
import { type FixturePair, readFixture } from "./fixture.ts";
import { forEachLimited, HttpError, request, sleep } from "./http.ts";
import { serverCpuSeconds, serverMemoryMb } from "./memory.ts";
import { round, summarize } from "./stats.ts";

/**
 * The WebSocket fan-out test. Many pairs of people, each pair in a direct chat: the first sends
 * messages over REST, the second listens on a socket. It measures how long a message takes from
 * "send" to "arrives", whether any message is lost or arrives twice, and what a connection costs
 * in memory. With `--chaos-cmd` it runs a command mid-test (kill an API instance) and measures
 * how long the clients take to come back and catch up.
 *
 * Two ways to aim it:
 *   --base-url http://lb:8080            everything goes through the load balancer. This is the
 *                                        realistic run, and the one for the chaos test.
 *   --targets http://h:3101,http://h:3102,http://h:3103
 *                                        each instance directly. Pair i sends through instance
 *                                        i mod k and listens on instance (i+1) mod k, so every
 *                                        message must cross Redis to reach its listener. This is
 *                                        the run that proves cross-instance delivery.
 *
 * What "lost" means. A socket that is down misses what is sent meanwhile, and the web app's
 * answer is to refetch after it reconnects. So the test counts both: `lostLive` (not received on
 * the socket) and `lostAfterResync` (still missing after fetching the chat's history like the web
 * app does). With no chaos, `lostLive` must be zero too. A message counts as sent only once the
 * API said so; sends that fail are retried with the same `clientId` (the API makes that safe), and
 * the ones that never succeed are reported apart and not counted as lost.
 */

const options = new Options(process.argv.slice(2));
const TRAILING_SLASH = /\/$/u;
const baseUrl = options.string("base-url", "http://localhost:3001").replace(TRAILING_SLASH, "");
const targets = options.list("targets").map((url) => url.replace(TRAILING_SLASH, ""));
const fixture = readFixture(options.string("fixture", "fixture.json"));
const pairCount = Math.min(options.number("pairs", fixture.pairs.length), fixture.pairs.length);
const durationS = options.number("duration", 60);
const rate = options.number("rate", 0.5);
const connectRate = options.number("connect-rate", 100);
const graceS = options.number("grace", 10);
const chaosCmd = options.optional("chaos-cmd");
const chaosAtS = options.number("chaos-at", 20);
const outPath = options.optional("out");
const strict = options.flag("strict");
const memorySpec = options.optional("server-memory");
const label = options.optional("label") ?? "";
const loginConcurrency = options.number("login-concurrency", 16);

if (chaosCmd && targets.length > 0) {
  throw new Error(
    "--chaos-cmd needs the load balancer (--base-url): clients on a fixed instance cannot move.",
  );
}
if (targets.length === 1) {
  throw new Error("--targets needs at least two instances, or messages never cross instances.");
}

const runId = randomUUID().slice(0, 8);
const pairs = fixture.pairs.slice(0, pairCount);

// ---------------------------------------------------------------------------------------------
// State

interface Client {
  chatId: string;
  connectedOnce: boolean;
  disconnectedAt: number | null;
  email: string;
  failedToConnect: boolean;
  password: string;
  role: "a" | "b";
  socket: Socket | null;
  token: string;
  url: string;
}

interface PairState {
  a: Client;
  /** Sends the API accepted. */
  accepted: Set<number>;
  b: Client;
  chatId: string;
  /** What A's own socket heard of its sends (the "other devices" echo). */
  echoed: Set<number>;
  failedSends: number;
  nextSeq: number;
  /** What B received on its socket, and what it got only from history afterwards. */
  received: Set<number>;
  recovered: Set<number>;
  /** The instance this pair's REST calls go to. */
  restUrl: string;
  /** seq -> when the send started (ms, performance.now) */
  sentAt: Map<number, number>;
}

const latencies: number[] = [];
const sendLatencies: number[] = [];
const counters = {
  connectErrors: 0,
  duplicates: 0,
  echoDuplicates: 0,
  resyncs: 0,
  sendRetries: 0,
  sendsFailedForGood: 0,
  eventsOther: 0,
  disconnects: 0,
};
const reconnects: {
  reconnectMs: number;
  resyncMs: number;
  resyncDoneAt: number;
  disconnectedAt: number;
}[] = [];
const loop = monitorEventLoopDelay({ resolution: 10 });

const textOf = (seq: number, pair: number) => `lt|${runId}|${pair}|${seq}`;
function parseText(text: string | null): { pair: number; seq: number } | null {
  if (!text?.startsWith(`lt|${runId}|`)) {
    return null;
  }
  const [, , pair, seq] = text.split("|");
  return { pair: Number(pair), seq: Number(seq) };
}

const states: PairState[] = pairs.map((pair: FixturePair, index) => {
  const senderUrl = targets.length > 0 ? (targets[index % targets.length] as string) : baseUrl;
  const listenerUrl =
    targets.length > 0 ? (targets[(index + 1) % targets.length] as string) : baseUrl;
  const client = (role: "a" | "b", url: string): Client => ({
    chatId: pair.chatId,
    connectedOnce: false,
    disconnectedAt: null,
    email: pair[role].email,
    failedToConnect: false,
    password: pair[role].password,
    role,
    socket: null,
    token: "",
    url,
  });
  return {
    a: client("a", senderUrl),
    b: client("b", listenerUrl),
    chatId: pair.chatId,
    sentAt: new Map(),
    accepted: new Set(),
    received: new Set(),
    recovered: new Set(),
    echoed: new Set(),
    failedSends: 0,
    nextSeq: 0,
    restUrl: senderUrl,
  };
});
const clients = states.flatMap((state) => [state.a, state.b]);

// ---------------------------------------------------------------------------------------------
// Steps

async function login(client: Client): Promise<void> {
  const result = await request<AuthResult>(`${client.url}/auth/login`, {
    body: { email: client.email, password: client.password },
  });
  client.token = result.accessToken;
}

/** Fetches the chat's recent history as the client's user and files what it finds under `target`. */
async function resync(client: Client, into: Set<number>, already: Set<number>) {
  counters.resyncs += 1;
  let before: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const query = before ? `?limit=100&before=${before}` : "?limit=100";
    // biome-ignore lint/performance/noAwaitInLoops: each page needs the previous page's cursor.
    const result: MessagePage = await request<MessagePage>(
      `${client.url}/chats/${client.chatId}/messages${query}`,
      {
        token: client.token,
      },
    );
    for (const message of result.items) {
      const parsed = parseText(message.text);
      if (parsed && !already.has(parsed.seq)) {
        into.add(parsed.seq);
      }
    }
    before = result.nextCursor;
    if (!before) {
      break;
    }
  }
}

function connect(client: Client, state: PairState, index: number): Promise<void> {
  return new Promise((resolve) => {
    const socket = io(client.url, {
      transports: ["websocket"],
      auth: (callback) => callback({ token: client.token }),
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
      timeout: 20_000,
    });
    client.socket = socket;
    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    socket.on("connect", () => {
      const first = !client.connectedOnce;
      client.connectedOnce = true;
      settle();
      if (!first && client.disconnectedAt !== null) {
        const { disconnectedAt } = client;
        const reconnectedAt = performance.now();
        client.disconnectedAt = null;
        // Like the web app, catch up on what was missed while the socket was down.
        // The sender's socket only hears echoes, which nobody counts as lost, so its catch-up goes nowhere.
        resync(
          client,
          client.role === "b" ? state.recovered : new Set(),
          client.role === "b" ? state.received : state.echoed,
        )
          .then(() => {
            reconnects.push({
              disconnectedAt,
              reconnectMs: reconnectedAt - disconnectedAt,
              resyncMs: performance.now() - reconnectedAt,
              resyncDoneAt: performance.now(),
            });
          })
          .catch(() => {
            // A failed resync leaves messages missing, which the final count then reports.
          });
      }
    });
    socket.on("disconnect", (reason) => {
      if (reason !== "io client disconnect") {
        counters.disconnects += 1;
        client.disconnectedAt ??= performance.now();
      }
    });
    socket.on("connect_error", () => {
      counters.connectErrors += 1;
      // Still trying: socket.io keeps reconnecting. Give up waiting for it after the timeout.
    });
    socket.on("message:new", ({ message }: { message: MessageDto }) => {
      const now = performance.now();
      const parsed = parseText(message.text);
      if (!parsed || parsed.pair !== index) {
        return;
      }
      if (client.role === "b") {
        if (state.received.has(parsed.seq)) {
          counters.duplicates += 1;
          return;
        }
        state.received.add(parsed.seq);
        const startedAt = state.sentAt.get(parsed.seq);
        if (startedAt !== undefined) {
          latencies.push(now - startedAt);
        }
      } else {
        if (state.echoed.has(parsed.seq)) {
          counters.echoDuplicates += 1;
          return;
        }
        state.echoed.add(parsed.seq);
      }
    });
    for (const event of [
      "message:updated",
      "chat:updated",
      "chat:removed",
      "typing",
      "presence",
      "status:new",
    ]) {
      socket.on(event, () => {
        counters.eventsOther += 1;
      });
    }
    setTimeout(() => {
      if (!settled) {
        client.failedToConnect = true;
        settle();
      }
    }, 30_000).unref();
  });
}

async function sendOne(state: PairState, index: number): Promise<void> {
  const seq = state.nextSeq;
  state.nextSeq += 1;
  const clientId = randomUUID();
  const text = textOf(seq, index);
  const startedAt = performance.now();
  state.sentAt.set(seq, startedAt);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: a retry must wait for the failure before it.
      await request<MessageDto>(`${state.restUrl}/chats/${state.chatId}/messages`, {
        token: state.a.token,
        body: { clientId, kind: "text", text },
        timeoutMs: 15_000,
      });
      sendLatencies.push(performance.now() - startedAt);
      state.accepted.add(seq);
      return;
    } catch (error) {
      // A 4xx will not get better by trying again. Network errors and 5xx do (an instance may be
      // going away), and the same clientId makes the retry safe.
      const permanent = error instanceof HttpError && error.status < 500 && error.status !== 429;
      if (permanent || attempt === 5) {
        break;
      }
      counters.sendRetries += 1;
      await sleep(250 * (attempt + 1));
    }
  }
  state.failedSends += 1;
  counters.sendsFailedForGood += 1;
}

// ---------------------------------------------------------------------------------------------
// Run

const { gc } = globalThis as { gc?: () => void };
const hostInfo = {
  cpus: os.cpus().length,
  cpuModel: os.cpus()[0]?.model ?? "unknown",
  memoryGb: round(os.totalmem() / 1024 ** 3, 1),
  node: process.version,
  platform: `${os.platform()} ${os.release()}`,
};

console.log(
  `Run ${runId}: ${pairCount} pairs (${pairCount * 2} sockets), ${durationS} s at ${rate} msg/s per pair, ` +
    (targets.length > 0 ? `direct to ${targets.length} instances` : `through ${baseUrl}`),
);

loop.enable();
const t0 = Date.now();

console.log("Logging in...");
await forEachLimited(clients, loginConcurrency, login);
console.log(`  ${clients.length} logged in in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// A token lasts 15 minutes and the API closes a socket when its token ends. A long run keeps its
// people signed in, one at a time so it is not a login storm.
const relogin = setInterval(() => {
  let delay = 0;
  for (const client of clients) {
    setTimeout(() => void login(client).catch(() => undefined), delay);
    delay += 10;
  }
}, 10 * 60_000);
relogin.unref();

gc?.();
await sleep(500);
const clientRssBefore = process.memoryUsage().rss;
const serverBefore = serverMemoryMb(memorySpec);

console.log(`Connecting ${clients.length} sockets at up to ${connectRate}/s...`);
const connectStarted = Date.now();
const connecting: Promise<void>[] = [];
for (const [index, state] of states.entries()) {
  connecting.push(connect(state.a, state, index), connect(state.b, state, index));
  // Pace the ramp: two sockets per pair.
  if ((index + 1) % Math.max(1, Math.round(connectRate / 2)) === 0) {
    // biome-ignore lint/performance/noAwaitInLoops: this is the ramp's pacing.
    await sleep(1000);
  }
}
await Promise.all(connecting);
const connectedCount = clients.filter((client) => client.socket?.connected).length;
const failedToConnect = clients.filter((client) => client.failedToConnect).length;
console.log(
  `  ${connectedCount}/${clients.length} connected in ${((Date.now() - connectStarted) / 1000).toFixed(1)} s` +
    (failedToConnect > 0 ? `, ${failedToConnect} gave up` : ""),
);

// Let presence and the adapter's own traffic settle before the memory reading.
await sleep(3000);
gc?.();
const clientRssAfter = process.memoryUsage().rss;
const serverAfter = serverMemoryMb(memorySpec);

console.log(`Sending for ${durationS} s...`);
const cpuBefore = serverCpuSeconds(memorySpec);
const sendStarted = performance.now();
const sendEnd = sendStarted + durationS * 1000;
const intervalMs = 1000 / rate;
const timers: NodeJS.Timeout[] = [];
const inFlight = new Set<Promise<void>>();
for (const [index, state] of states.entries()) {
  const run = () => {
    if (performance.now() >= sendEnd) {
      return;
    }
    const sending = sendOne(state, index).finally(() => inFlight.delete(sending));
    inFlight.add(sending);
  };
  // Spread the pairs over one interval so the load is steady and not a spike each second.
  const timer = setTimeout(() => {
    run();
    const repeating = setInterval(() => {
      if (performance.now() >= sendEnd) {
        clearInterval(repeating);
        return;
      }
      run();
    }, intervalMs);
    timers.push(repeating);
  }, Math.random() * intervalMs);
  timers.push(timer);
}

let chaos: { startedAt: number; finishedAt: number | null; output: string } | null = null;
if (chaosCmd) {
  setTimeout(() => {
    console.log(`Chaos at ${chaosAtS} s: ${chaosCmd}`);
    chaos = { startedAt: performance.now(), finishedAt: null, output: "" };
    exec(chaosCmd, (error, stdout, stderr) => {
      if (chaos) {
        chaos.finishedAt = performance.now();
        chaos.output = `${stdout}${stderr}${error ? `\n${error.message}` : ""}`.trim();
      }
    });
  }, chaosAtS * 1000).unref();
}

await sleep(durationS * 1000);
for (const timer of timers) {
  clearTimeout(timer);
  clearInterval(timer);
}
await Promise.allSettled([...inFlight]);
const cpuAfter = serverCpuSeconds(memorySpec);
console.log(`Draining for ${graceS} s...`);
await sleep(graceS * 1000);

// ---------------------------------------------------------------------------------------------
// Count

let sent = 0;
let receivedLive = 0;
let missingLive = 0;
let recoveredByResync = 0;
let missingFinal = 0;
let echoMissing = 0;
const stillMissing: PairState[] = [];
for (const state of states) {
  sent += state.accepted.size;
  for (const seq of state.accepted) {
    if (state.received.has(seq)) {
      receivedLive += 1;
    } else {
      missingLive += 1;
      stillMissing.push(state);
    }
    if (!state.echoed.has(seq)) {
      echoMissing += 1;
    }
  }
}

// Whatever is missing live gets one more chance, the way the web app would: ask for the history.
if (missingLive > 0) {
  console.log(
    `${missingLive} messages were not received live. Fetching history for those chats...`,
  );
  await forEachLimited([...new Set(stillMissing)], 16, async (state) => {
    await login(state.b).catch(() => undefined);
    await resync(state.b, state.recovered, state.received).catch(() => undefined);
  });
}
for (const state of states) {
  for (const seq of state.accepted) {
    if (state.received.has(seq)) {
      continue;
    }
    if (state.recovered.has(seq)) {
      recoveredByResync += 1;
    } else {
      missingFinal += 1;
    }
  }
}

const afterChaos = chaos
  ? reconnects.filter(
      (entry) => entry.disconnectedAt >= (chaos as { startedAt: number }).startedAt - 50,
    )
  : [];
const recoveryMs =
  chaos && afterChaos.length > 0
    ? Math.max(...afterChaos.map((entry) => entry.resyncDoneAt)) -
      (chaos as { startedAt: number }).startedAt
    : null;
const stillDown = clients.filter((client) => client.disconnectedAt !== null).length;

const e2e = summarize(latencies);
const post = summarize(sendLatencies);
const lag = {
  p50: loop.percentile(50) / 1e6,
  p99: loop.percentile(99) / 1e6,
  max: loop.max / 1e6,
};
const sockets = connectedCount;
const clientKbPerSocket = sockets > 0 ? (clientRssAfter - clientRssBefore) / 1024 / sockets : null;
const serverKbPerSocket =
  serverBefore !== null && serverAfter !== null && sockets > 0
    ? ((serverAfter - serverBefore) * 1024) / sockets
    : null;

const result = {
  label,
  runId,
  finishedAt: new Date().toISOString(),
  host: hostInfo,
  config: {
    mode: targets.length > 0 ? "direct-to-instances" : "load-balancer",
    target: targets.length > 0 ? targets : baseUrl,
    pairs: pairCount,
    sockets: clients.length,
    durationS,
    ratePerPair: rate,
    chaosCmd: chaosCmd ?? null,
    chaosAtS: chaosCmd ? chaosAtS : null,
  },
  sockets: {
    connected: connectedCount,
    failedToConnect,
    connectErrors: counters.connectErrors,
    stillDownAtEnd: stillDown,
  },
  messages: {
    sent,
    receivedLive,
    lostLive: missingLive,
    recoveredByResync,
    lostAfterResync: missingFinal,
    duplicates: counters.duplicates,
    echoMissingOnSenderSocket: echoMissing,
    echoDuplicates: counters.echoDuplicates,
    sendsFailedForGood: counters.sendsFailedForGood,
    sendRetries: counters.sendRetries,
    throughputPerS: round(sent / durationS, 1),
  },
  latencyMs: { sendToReceive: roundSummary(e2e), postRoundTrip: roundSummary(post) },
  recovery: chaos
    ? {
        chaosOutput: (chaos as { output: string }).output,
        clientsReconnected: afterChaos.length,
        reconnectMs: roundSummary(summarize(afterChaos.map((entry) => entry.reconnectMs))),
        resyncMs: roundSummary(summarize(afterChaos.map((entry) => entry.resyncMs))),
        allBackMs: recoveryMs === null ? null : round(recoveryMs, 0),
      }
    : null,
  memory: {
    clientKbPerSocket: clientKbPerSocket === null ? null : round(clientKbPerSocket, 1),
    serverKbPerSocket: serverKbPerSocket === null ? null : round(serverKbPerSocket, 1),
    serverMbBefore: serverBefore === null ? null : round(serverBefore, 0),
    serverMbAfter: serverAfter === null ? null : round(serverAfter, 0),
  },
  serverCpu:
    cpuBefore !== null && cpuAfter !== null && sent > 0
      ? {
          secondsDuringSend: round(cpuAfter - cpuBefore, 1),
          // While sending, per accepted message: REST handling, SQL, fan-out and delivery,
          // plus the sockets' heartbeats. The one number to compare before and after a change.
          msPerMessage: round(((cpuAfter - cpuBefore) * 1000) / sent, 2),
        }
      : null,
  harnessEventLoopLagMs: { p50: round(lag.p50, 1), p99: round(lag.p99, 1), max: round(lag.max, 1) },
};

function roundSummary(summary: ReturnType<typeof summarize>) {
  return {
    count: summary.count,
    min: round(summary.min),
    p50: round(summary.p50),
    p95: round(summary.p95),
    p99: round(summary.p99),
    max: round(summary.max),
  };
}

for (const client of clients) {
  client.socket?.disconnect();
}

console.log(JSON.stringify(result, null, 2));
if (outPath) {
  writeFileSync(outPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`Wrote ${outPath}`);
}

const expectLossless = !chaosCmd;
const failed =
  missingFinal > 0 ||
  counters.duplicates > 0 ||
  failedToConnect > 0 ||
  (expectLossless && (missingLive > 0 || echoMissing > 0));
if (strict && failed) {
  console.error("FAILED: messages were lost or duplicated, or sockets did not connect.");
  process.exitCode = 1;
}
// Sockets and timers are closed above, but be sure nothing keeps the process alive.
setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
