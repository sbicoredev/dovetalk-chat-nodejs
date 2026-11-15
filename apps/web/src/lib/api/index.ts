import { UPLOAD_LIMIT_BYTES } from "@dovetalk/contracts";

import { createSessionManager, type SessionManager } from "@/lib/auth/session-manager";
import { getToken, useSession } from "@/lib/stores/session";

import type { Api, RealtimeClient } from "./api";
import { resolveEndpoints } from "./endpoints";
import { createHttpApi } from "./http";
import { createMockApi, type MockApi } from "./mock/server";
import { createLocalStorageStorage } from "./mock/storage";
import { createSocketRealtime } from "./socket";

/**
 * Pick the backend with environment variables (see apps/web/.env.example). They are read when the
 * app is built, not when it starts:
 *   NEXT_PUBLIC_API_URL  where REST calls go: the API's URL, or "/api" to go through the web
 *                        app's own proxy. When unset, the in-browser mock server is used.
 *   NEXT_PUBLIC_WS_URL   where the socket connects. Needed when the API URL is a path.
 */
const API_URL = process.env.NEXT_PUBLIC_API_URL?.trim() || "";
const WS_URL = process.env.NEXT_PUBLIC_WS_URL?.trim() || "";
const MOCK_LATENCY = Number(process.env.NEXT_PUBLIC_MOCK_LATENCY_MS ?? 220);

export const isMockApi = API_URL === "";

/** Largest file the backend will take, used to reject uploads before sending them. */
export const uploadLimitBytes = isMockApi ? 1_500_000 : UPLOAD_LIMIT_BYTES;

export interface Backend {
  api: Api;
  /** Only present when the mock server is in use. */
  mock: MockApi | null;
  realtime: RealtimeClient;
  /** Keeps the person signed in: restores the session, renews the access token. */
  session: SessionManager;
}

let backend: Backend | null = null;

export function getBackend(): Backend {
  if (backend) {
    return backend;
  }
  // The Api is built with the session manager's `refresh`, and the manager needs the Api to call
  // it: `getApi` closes that loop, and is only called once a request has been made.
  const session = createSessionManager({ getApi: () => getBackend().api });
  const endpoints = resolveEndpoints(API_URL, WS_URL);
  if (endpoints) {
    backend = {
      api: createHttpApi({
        baseUrl: endpoints.apiUrl,
        getToken,
        refreshSession: session.refresh,
        onUnauthorized: () => useSession.getState().clear(),
      }),
      realtime: createSocketRealtime({
        url: endpoints.wsUrl,
        getToken,
        refreshToken: session.refresh,
      }),
      mock: null,
      session,
    };
  } else {
    const mock = createMockApi({
      getToken,
      latencyMs: Number.isFinite(MOCK_LATENCY) ? MOCK_LATENCY : 220,
      storage: typeof window === "undefined" ? null : createLocalStorageStorage(),
      uploadLimitBytes,
    });
    backend = { api: mock.api, realtime: mock.realtime, mock, session };
  }
  return backend;
}
