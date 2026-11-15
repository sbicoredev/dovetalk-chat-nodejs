import type { Api } from "@/lib/api/api";
import { isApiError } from "@/lib/api/errors";
import type { RefreshOutcome } from "@/lib/api/http";
import type { AuthResult, MeDto } from "@/lib/api/types";
import { useSession } from "@/lib/stores/session";

/** Renew this long before the token runs out, so a request never meets an expired one. */
const RENEW_BEFORE_EXPIRY_MS = 60_000;
/** Never renew more often than this, whatever the token says. */
const MIN_RENEW_DELAY_MS = 5000;
/** When the server could not be reached to renew, try again after this long. */
const RETRY_DELAY_MS = 30_000;
/** setTimeout cannot wait longer than a signed 32-bit number of milliseconds. */
const MAX_TIMER_MS = 2_147_483_647;
/** Where earlier versions kept the access token. It is removed, so an old copy cannot linger. */
const LEGACY_TOKEN_KEY = "dovetalk:token";

/** When a JWT stops working, in epoch milliseconds, or null if it is not a JWT (the mock's are not). */
export function tokenExpiry(token: string): number | null {
  try {
    const [, payload = ""] = token.split(".");
    const json = atob(payload.replace(/-/gu, "+").replace(/_/gu, "/"));
    const { exp } = JSON.parse(json) as { exp?: unknown };
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

export interface SessionManagerOptions {
  /** Looked up when needed, because the Api is built with this manager's `refresh`. */
  getApi: () => Api;
  now?: () => number;
  /** Where the token lives. Defaults to the app's store. */
  store?: typeof useSession;
}

export interface SessionManager {
  /** Stops the renewal timer. */
  dispose: () => void;
  /** Hears about the user when a sign-in is restored (not when a token is only renewed). */
  onRestored: (handler: (user: MeDto) => void) => () => void;
  /**
   * Gets a new access token from the refresh cookie. Calls made while one is under way share it,
   * so a burst of failing requests rotates the cookie once.
   */
  refresh: () => Promise<RefreshOutcome>;
  /** Tries to restore the sign-in left by an earlier visit. Run once when the page loads. */
  restore: () => Promise<void>;
  /** Starts a session from a sign-in, sign-up or guest result. */
  signIn: (result: AuthResult) => void;
}

/**
 * Keeps the person signed in. The access token lives in memory only (see `stores/session.ts`),
 * so this is what gets a new one: when the page loads, a little before the current one expires,
 * and when a request or the socket is turned away with 401.
 */
export function createSessionManager(options: SessionManagerOptions): SessionManager {
  const store = options.store ?? useSession;
  const now = options.now ?? Date.now;
  const restoredHandlers = new Set<(user: MeDto) => void>();
  let inflight: Promise<RefreshOutcome> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const stopTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  async function run(): Promise<RefreshOutcome> {
    const hadToken = store.getState().token !== null;
    try {
      const result = await options.getApi().auth.refresh();
      store.getState().setToken(result.accessToken);
      if (!hadToken) {
        restoredHandlers.forEach((handler) => handler(result.user));
      }
      return "refreshed";
    } catch (error) {
      // 401 means the cookie is gone, expired or was used twice. 403 means the page's origin
      // is not allowed to use it. Either way nobody is signed in here.
      if (isApiError(error) && (error.status === 401 || error.status === 403)) {
        store.getState().clear();
        return "signed-out";
      }
      return "unavailable";
    }
  }

  function refresh(): Promise<RefreshOutcome> {
    inflight ??= run().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  function schedule(token: string | null, delayOverride?: number) {
    stopTimer();
    if (!token) {
      return;
    }
    const expiry = tokenExpiry(token);
    if (expiry === null && delayOverride === undefined) {
      return; // Not a JWT: this token does not expire.
    }
    const wait =
      delayOverride ?? Math.max(MIN_RENEW_DELAY_MS, (expiry ?? 0) - now() - RENEW_BEFORE_EXPIRY_MS);
    timer = setTimeout(
      async () => {
        timer = null;
        if ((await refresh()) === "unavailable") {
          schedule(store.getState().token, RETRY_DELAY_MS);
        }
      },
      Math.min(wait, MAX_TIMER_MS),
    );
  }

  // A new token (from any source) restarts the clock. Signing out stops it.
  const unsubscribe = store.subscribe((state, previous) => {
    if (state.token !== previous.token) {
      schedule(state.token);
    }
  });

  return {
    refresh,
    signIn: (result) => store.getState().setToken(result.accessToken),
    onRestored(handler) {
      restoredHandlers.add(handler);
      return () => {
        restoredHandlers.delete(handler);
      };
    },
    async restore() {
      try {
        localStorage.removeItem(LEGACY_TOKEN_KEY);
      } catch {
        // Storage may be blocked. There is then nothing to remove.
      }
      store.getState().restoreReset();
      const outcome = await refresh();
      if (outcome === "unavailable") {
        store
          .getState()
          .restoreFailed("Can't reach the server. Check your connection and try again.");
      }
    },
    dispose() {
      stopTimer();
      unsubscribe();
    },
  };
}
