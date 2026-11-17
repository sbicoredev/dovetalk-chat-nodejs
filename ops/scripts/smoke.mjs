#!/usr/bin/env node
// The first minute of the demo, as a script: sign in as a guest, see the seeded chats, write to a bot
// and wait for its reply. Exits 1 if any step fails or the reply takes longer than the limit.
//
//   API_URL=http://localhost:3001 node ops/scripts/smoke.mjs
//
// Needs the API and the worker running (the worker is what makes the bot answer).

const base = process.env.API_URL ?? "http://localhost:3001";
const replyLimitMs = Number(process.env.REPLY_LIMIT_MS ?? 15_000);

async function call(method, path, { token, body, expect } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  if (expect ? !expect.includes(response.status) : !response.ok) {
    throw new Error(`${method} ${path} answered ${response.status}: ${text.slice(0, 200)}`);
  }
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

function step(name) {
  console.log(`- ${name}`);
}

const { json: auth } = await call("POST", "/auth/guest");
step(`guest signed in as ${auth.user.name}`);

const { json: chats } = await call("GET", "/chats", { token: auth.accessToken });
if (chats.length === 0) {
  throw new Error("The guest has no chats, so the seed did not run.");
}
step(`${chats.length} seeded chats`);

// Some seeded contacts are blocked, which refuses the send. Use the first direct chat that accepts one.
let sent;
for (const chat of chats.filter((candidate) => candidate.type === "direct")) {
  const startedAt = Date.now();
  const clientId = crypto.randomUUID();
  // biome-ignore lint/performance/noAwaitInLoops: one at a time on purpose, it stops at the first chat that accepts a send.
  const response = await call("POST", `/chats/${chat.id}/messages`, {
    token: auth.accessToken,
    body: { clientId, kind: "text", text: "hello" },
    expect: [201, 403],
  });
  if (response.status === 201) {
    sent = { chat, startedAt };
    break;
  }
}
if (!sent) {
  throw new Error("No direct chat accepted a message.");
}
step("sent a message to a bot");

const deadline = sent.startedAt + replyLimitMs;
let reply;
while (!reply && Date.now() <= deadline) {
  // biome-ignore lint/performance/noAwaitInLoops: polling, each look comes after the last one.
  const { json: page } = await call("GET", `/chats/${sent.chat.id}/messages?limit=10`, {
    token: auth.accessToken,
  });
  reply = page.items.find(
    (message) =>
      message.senderId !== auth.user.id &&
      message.kind !== "system" &&
      message.createdAt >= sent.startedAt,
  );
  if (!reply) {
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
if (!reply) {
  throw new Error(`No reply within ${replyLimitMs} ms. Is the worker running?`);
}
step(`the bot answered after ${Date.now() - sent.startedAt} ms`);
console.log("Smoke test passed.");
