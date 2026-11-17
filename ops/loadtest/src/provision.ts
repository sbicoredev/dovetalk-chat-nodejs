import { writeFileSync } from "node:fs";

import type { AuthResult, ChatDto, ContactDto } from "@dovetalk/contracts";

import { Options } from "./args.ts";
import type { Fixture, FixturePair, FixtureUser } from "./fixture.ts";
import { forEachLimited, HttpError, request } from "./http.ts";

/**
 * Makes the people a load test needs: `pairs` pairs of accounts, each pair with a direct chat, and
 * writes who they are to a fixture file. Running it again reuses accounts that exist (a taken
 * email means "log in instead"), so it is safe to repeat and to grow.
 *
 *   node src/provision.ts --base-url http://localhost:3001 --pairs 1000 --out fixture.json
 *
 * Every account goes through the real sign-up, so each one gets the seeded demo data (contacts,
 * chats, messages, statuses) like a person signing up would. That is slow on purpose: it is also
 * what a burst of new users costs the API. The API's rate limits must be raised for this
 * (RATE_LIMIT_REGISTER and RATE_LIMIT_GLOBAL, the Compose `scale` profile does it).
 */

const PASSWORD = "loadtest-password-1";
const DOMAIN = "loadtest.example";

const options = new Options(process.argv.slice(2));
const baseUrl = options.string("base-url", "http://localhost:3001").replace(/\/$/u, "");
const pairCount = options.number("pairs", 50);
const out = options.string("out", "fixture.json");
const concurrency = options.number("concurrency", 8);
const tag = options.string("tag", "a");
// A person's phone number is how a contact is found, and it must be unique.
const phoneBase = options.number("phone-base", 1_000_000);

function person(pair: number, side: "a" | "b") {
  const n = pair * 2 + (side === "a" ? 0 : 1);
  return {
    email: `lt-${tag}-${pair}-${side}@${DOMAIN}`,
    name: `Load ${tag.toUpperCase()}${pair}${side}`,
    password: PASSWORD,
    phone: `+1555${String(phoneBase + n)}`,
  };
}

async function ensureUser(input: ReturnType<typeof person>): Promise<AuthResult> {
  try {
    return await request<AuthResult>(`${baseUrl}/auth/register`, { body: input });
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) {
      return request<AuthResult>(`${baseUrl}/auth/login`, {
        body: { email: input.email, password: input.password },
      });
    }
    throw error;
  }
}

async function ensurePair(index: number): Promise<FixturePair> {
  const [a, b] = await Promise.all([
    ensureUser(person(index, "a")),
    ensureUser(person(index, "b")),
  ]);
  const contact = await request<ContactDto>(`${baseUrl}/contacts`, {
    token: a.accessToken,
    body: { name: person(index, "b").name, phone: person(index, "b").phone },
  });
  const chat = await request<ChatDto>(`${baseUrl}/chats`, {
    token: a.accessToken,
    body: { type: "direct", contactId: contact.id },
  });
  const user = (result: AuthResult, side: "a" | "b"): FixtureUser => ({
    id: result.user.id,
    email: person(index, side).email,
    password: PASSWORD,
  });
  return { a: user(a, "a"), b: user(b, "b"), chatId: chat.id };
}

const started = Date.now();
const pairs: FixturePair[] = new Array(pairCount);
let done = 0;
await forEachLimited(
  Array.from({ length: pairCount }, (_, index) => index),
  concurrency,
  async (index) => {
    pairs[index] = await ensurePair(index);
    done += 1;
    if (done % 50 === 0 || done === pairCount) {
      const seconds = (Date.now() - started) / 1000;
      console.log(`${done}/${pairCount} pairs (${(done / seconds).toFixed(1)} pairs/s)`);
    }
  },
);

const fixture: Fixture = { createdAt: new Date().toISOString(), pairs };
writeFileSync(out, `${JSON.stringify(fixture)}\n`);
console.log(
  `Wrote ${pairCount} pairs (${pairCount * 2} accounts) to ${out} in ${((Date.now() - started) / 1000).toFixed(1)} s.`,
);
