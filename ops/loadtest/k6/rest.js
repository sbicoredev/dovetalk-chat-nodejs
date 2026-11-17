// REST load for Dovetalk with k6 (https://grafana.com/docs/k6/). k6 does not speak the socket.io
// protocol, so sockets are the Node harness's job (src/ws-fanout.ts); this covers the request side:
// sign in, list chats, page back through history, send messages.
//
//   k6 run -e BASE_URL=http://localhost:8080 -e FIXTURE=fixture.json ops/loadtest/k6/rest.js
//
// Make the fixture first: node ops/loadtest/src/provision.ts --pairs 200 --out fixture.json
// The API's rate limits must be raised (the Compose `scale` profile does it).
//
// Options (-e NAME=value): VUS (default 50), DURATION (default 60s), WRITE_RATIO (share of
// iterations that send a message instead of only reading, default 0.3).
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";

const BASE_URL = (__ENV.BASE_URL || "http://localhost:8080").replace(/\/$/u, "");
const WRITE_RATIO = Number(__ENV.WRITE_RATIO || 0.3);

// Only the sender side of each pair is needed: it has a chat with history to read and to write to.
const pairs = new SharedArray(
  "pairs",
  () => JSON.parse(open(__ENV.FIXTURE || "fixture.json")).pairs,
);

const sendDuration = new Trend("dovetalk_send_duration", true);
const listDuration = new Trend("dovetalk_list_chats_duration", true);
const pageDuration = new Trend("dovetalk_page_history_duration", true);
const sent = new Counter("dovetalk_messages_sent");

export const options = {
  scenarios: {
    mixed: {
      executor: "constant-vus",
      vus: Number(__ENV.VUS || 50),
      duration: __ENV.DURATION || "60s",
    },
  },
  thresholds: {
    // Failing a threshold makes k6 exit non-zero, which is what lets CI use this as a gate.
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
    // Generous: these hold on a laptop with the whole stack on it. See docs/scaling.md.
    dovetalk_list_chats_duration: ["p(95)<400"],
    dovetalk_page_history_duration: ["p(95)<300"],
    dovetalk_send_duration: ["p(95)<400", "p(99)<1000"],
  },
};

const json = (token, body) => ({
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

// k6 runs `default` many times per VU and keeps module-level variables per VU.
let session = null;

function signIn() {
  const pair = pairs[(__VU - 1) % pairs.length];
  const res = http.post(
    `${BASE_URL}/auth/login`,
    JSON.stringify({ email: pair.a.email, password: pair.a.password }),
    { headers: { "Content-Type": "application/json" }, tags: { name: "POST /auth/login" } },
  );
  check(res, { "login 201": (r) => r.status === 201 || r.status === 200 });
  session = { token: res.json("accessToken"), chatId: pair.chatId, loggedInAt: Date.now() };
}

export default function () {
  // A token lasts 15 minutes: sign in again well before that on a long run.
  if (!session || Date.now() - session.loggedInAt > 10 * 60 * 1000) {
    signIn();
  }
  const { token, chatId } = session;

  const chats = http.get(`${BASE_URL}/chats`, { ...json(token), tags: { name: "GET /chats" } });
  listDuration.add(chats.timings.duration);
  check(chats, { "chats 200": (r) => r.status === 200 });

  const first = http.get(`${BASE_URL}/chats/${chatId}/messages?limit=25`, {
    ...json(token),
    tags: { name: "GET /chats/:id/messages" },
  });
  pageDuration.add(first.timings.duration);
  check(first, { "history 200": (r) => r.status === 200 });

  // Walk one page further back with the cursor, like scrolling up.
  const cursor = first.status === 200 ? first.json("nextCursor") : null;
  if (cursor) {
    const older = http.get(`${BASE_URL}/chats/${chatId}/messages?limit=25&before=${cursor}`, {
      ...json(token),
      tags: { name: "GET /chats/:id/messages" },
    });
    pageDuration.add(older.timings.duration);
    check(older, { "older page 200": (r) => r.status === 200 });
  }

  if (Math.random() < WRITE_RATIO) {
    const res = http.post(
      `${BASE_URL}/chats/${chatId}/messages`,
      JSON.stringify({
        clientId: `${__VU}-${__ITER}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        kind: "text",
        text: `k6 ${__VU}/${__ITER}`,
      }),
      { ...json(token), tags: { name: "POST /chats/:id/messages" } },
    );
    sendDuration.add(res.timings.duration);
    check(res, { "send 201": (r) => r.status === 201 || r.status === 200 });
    if (res.status < 300) {
      sent.add(1);
    }
  }

  sleep(0.5 + Math.random());
}
