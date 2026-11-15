import { randomUUID } from "node:crypto";

import { UPLOAD_LIMIT_BYTES } from "@dovetalk/contracts";

import { DEMO_EMAIL, DEMO_PASSWORD } from "@/lib/constants";

import type { Api, RealtimeClient } from "../api";
import { isApiError } from "../errors";
import { createHttpApi } from "../http";
import { createSocketRealtime } from "../socket";
import { CONFORMANCE_AREAS, type ConformanceArea, type ConformanceHarness } from "./harness";

/**
 * The areas the real API implements. Add one when its endpoints are built. `bots` needs the
 * worker running beside the API, because the worker is what answers: without it the bots test
 * waits and fails.
 */
export const IMPLEMENTED_AREAS: ReadonlySet<ConformanceArea> = new Set([
  "auth",
  "profile",
  "contacts",
  "paging",
  "chats",
  "sending",
  "actions",
  "uploads",
  "statuses",
  "realtime",
  "bots",
]);

/** Reads CONFORMANCE_AREAS: "all", or a comma separated list of area names. */
export function parseAreas(value: string | undefined): ReadonlySet<ConformanceArea> | "all" {
  const text = value?.trim();
  if (!text) {
    return IMPLEMENTED_AREAS;
  }
  if (text === "all") {
    return "all";
  }
  const names = text.split(",").map((name) => name.trim());
  const unknown = names.filter((name) => !(CONFORMANCE_AREAS as readonly string[]).includes(name));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown conformance area: ${unknown.join(", ")}. Known: ${CONFORMANCE_AREAS.join(", ")}.`,
    );
  }
  return new Set(names as ConformanceArea[]);
}

export interface HttpHarnessOptions {
  areas?: ReadonlySet<ConformanceArea> | "all";
  /** The API, for example http://localhost:3001. Paths such as /auth/login are added to it. */
  baseUrl: string;
  /** The socket.io server. Defaults to the origin of baseUrl. */
  wsUrl?: string;
}

const PASSWORD = "conformance-password";

/**
 * A fetch that keeps cookies, as a browser does, so the refresh cookie travels between calls.
 * One jar per client. It ignores cookie paths: it is made for one server.
 */
function cookieFetch(): typeof fetch {
  const jar = new Map<string, string>();
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    if (jar.size > 0) {
      headers.set("Cookie", [...jar].map(([name, value]) => `${name}=${value}`).join("; "));
    }
    const response = await fetch(input, { ...init, headers });
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      const maxAge = attributes.find((a) => /^\s*max-age=/iu.test(a))?.split("=")[1];
      const expires = attributes.find((a) => /^\s*expires=/iu.test(a))?.split("=")[1];
      const expired =
        value === "" ||
        (maxAge !== undefined && Number(maxAge) <= 0) ||
        (expires !== undefined && Date.parse(expires) <= Date.now());
      if (expired) {
        jar.delete(name);
      } else {
        jar.set(name, value);
      }
    }
    return response;
  };
}

/** Signs up a new account and returns its access token. */
async function signUp(api: Api): Promise<string> {
  try {
    const { accessToken } = await api.auth.register({
      email: `conformance-${randomUUID()}@example.com`,
      password: PASSWORD,
      name: "Conformance Tester",
    });
    return accessToken;
  } catch (error) {
    const hint =
      isApiError(error) && error.status === 429
        ? " The suite signs up one account per test: raise RATE_LIMIT_REGISTER."
        : "";
    throw new Error(`Could not sign up a test account. ${(error as Error).message}${hint}`);
  }
}

/** The real API, reached the way the web app reaches it: createHttpApi and the socket client. */
export function createHttpHarness(options: HttpHarnessOptions): ConformanceHarness {
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const wsUrl = options.wsUrl ?? new URL(baseUrl).origin;
  const sockets: RealtimeClient[] = [];

  return {
    name: "http",
    areas: options.areas ?? IMPLEMENTED_AREAS,
    demo: { email: DEMO_EMAIL, password: DEMO_PASSWORD },
    uploadLimitBytes: UPLOAD_LIMIT_BYTES,

    anonymous: () => createHttpApi({ baseUrl, getToken: () => null, fetch: cookieFetch() }),

    async login() {
      const accessToken = await signUp(createHttpApi({ baseUrl, getToken: () => null }));
      const getToken = () => accessToken;
      const realtime = createSocketRealtime({ url: wsUrl, getToken });
      sockets.push(realtime);
      return { api: createHttpApi({ baseUrl, getToken }), realtime };
    },

    async eventually(check, { timeoutMs = 10_000, message = "Timed out waiting." } = {}) {
      const deadline = Date.now() + timeoutMs;
      while (!check()) {
        if (Date.now() >= deadline) {
          throw new Error(message);
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },

    async cleanup() {
      for (const socket of sockets) {
        socket.disconnect();
      }
      sockets.length = 0;
    },
  };
}
