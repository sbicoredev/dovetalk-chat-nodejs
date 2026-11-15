import type { Api } from "./api";
import { ApiError } from "./errors";
import type { AttachmentDto, MessageDto, MessagePage } from "./types";

const TRAILING_SLASHES = /\/+$/u;

/**
 * What came of asking for a new access token. `refreshed`: `getToken()` now returns a new one.
 * `signed-out`: the server refused, so there is nothing to renew. `unavailable`: the server could
 * not be reached, so nothing is known and the person should not be signed out for it.
 */
export type RefreshOutcome = "refreshed" | "signed-out" | "unavailable";

export interface HttpApiOptions {
  /** For example "http://localhost:3001" or "/api". No trailing slash needed. */
  baseUrl: string;
  /** Override for tests. Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Returns the current access token, or null when signed out. */
  getToken: () => string | null;
  /** Called when a signed-in request is refused with 401 and the session could not be renewed. */
  onUnauthorized?: () => void;
  /**
   * Asked for a new access token when a signed-in request fails with 401. The request is then sent
   * once more with it. Leave out to sign out on the first 401. Several requests failing at once
   * should share one refresh (the session manager does that).
   */
  refreshSession?: () => Promise<RefreshOutcome>;
}

interface RequestOptions {
  body?: unknown;
  /** The refresh cookie travels with `/auth/*` calls, also across origins. */
  credentials?: RequestCredentials;
  form?: FormData;
  query?: Record<string, string | number | null | undefined>;
  /** Login failures are 401s that must not sign anyone out, and nor must a failed refresh. */
  skipUnauthorizedHandler?: boolean;
}

/** Options for the `/auth/*` calls: they carry the cookie and never trigger a refresh themselves. */
const AUTH_CALL: Pick<RequestOptions, "credentials" | "skipUnauthorizedHandler"> = {
  credentials: "include",
  skipUnauthorizedHandler: true,
};

/** Reads Nest's default error body, `{ statusCode, message, error }`, and our own `{ code }`. */
async function toApiError(response: Response): Promise<ApiError> {
  let message = "";
  let code = "";
  try {
    const body = (await response.json()) as {
      message?: string | string[];
      error?: string;
      code?: string;
    };
    message = Array.isArray(body.message) ? body.message.join(" ") : (body.message ?? "");
    code = body.code ?? body.error ?? "";
  } catch {
    // The body was empty or not JSON. Fall through to the defaults.
  }
  const fallback =
    response.status === 401
      ? "Your session has ended. Sign in again."
      : response.status === 403
        ? "You don't have permission to do that."
        : response.status === 404
          ? "That item no longer exists."
          : response.status >= 500
            ? "The server ran into a problem. Try again in a moment."
            : "The request couldn't be completed.";
  return new ApiError(
    response.status,
    (code || `HTTP_${response.status}`).toUpperCase().replace(/\s+/gu, "_"),
    message || fallback,
  );
}

export function createHttpApi(options: HttpApiOptions): Api {
  const base = options.baseUrl.replace(TRAILING_SLASHES, "");
  const doFetch = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function request<T>(
    method: string,
    path: string,
    opts: RequestOptions = {},
    isRetry = false,
  ): Promise<T> {
    const url = new URL(
      base + path,
      typeof window === "undefined" ? undefined : window.location.href,
    );
    for (const [key, value] of Object.entries(opts.query ?? {})) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    const token = options.getToken();
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    let body: BodyInit | undefined;
    if (opts.form) {
      body = opts.form; // The browser sets the multipart boundary.
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.body);
    }

    let response: Response;
    try {
      response = await doFetch(url.toString(), {
        method,
        headers,
        body,
        ...(opts.credentials ? { credentials: opts.credentials } : {}),
      });
    } catch {
      throw new ApiError(
        0,
        "NETWORK_ERROR",
        "Can't reach the server. Check your connection and try again.",
      );
    }

    if (!response.ok) {
      const error = await toApiError(response);
      if (response.status === 401 && token && !opts.skipUnauthorizedHandler) {
        if (!isRetry && options.refreshSession) {
          // Somebody else may have renewed the token while this request was in flight. Then
          // there is nothing to ask for: send it again with the new one.
          const outcome =
            options.getToken() === token ? await options.refreshSession() : "refreshed";
          if (outcome === "refreshed") {
            return request<T>(method, path, opts, true);
          }
          if (outcome === "unavailable") {
            throw new ApiError(
              0,
              "NETWORK_ERROR",
              "Can't reach the server. Check your connection and try again.",
            );
          }
        }
        options.onUnauthorized?.();
      }
      throw error;
    }
    if (response.status === 204) {
      return undefined as T;
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  const get = <T>(path: string, query?: RequestOptions["query"]) =>
    request<T>("GET", path, { query });
  const send = <T>(method: string, path: string, body?: unknown) =>
    request<T>(method, path, { body });

  return {
    auth: {
      guest: () => request("POST", "/auth/guest", AUTH_CALL),
      login: (input) => request("POST", "/auth/login", { ...AUTH_CALL, body: input }),
      logout: () => request("POST", "/auth/logout", AUTH_CALL),
      refresh: () => request("POST", "/auth/refresh", AUTH_CALL),
      register: (input) => request("POST", "/auth/register", { ...AUTH_CALL, body: input }),
    },
    me: {
      get: () => get("/me"),
      update: (input) => send("PATCH", "/me", input),
    },
    contacts: {
      list: () => get("/contacts"),
      create: (input) => send("POST", "/contacts", input),
      update: (id, input) => send("PATCH", `/contacts/${id}`, input),
      remove: (id) => send("DELETE", `/contacts/${id}`),
      setBlocked: (id, blocked) => send("PUT", `/contacts/${id}/block`, { blocked }),
    },
    chats: {
      list: () => get("/chats"),
      create: (input) => send("POST", "/chats", input),
      update: (id, input) => send("PATCH", `/chats/${id}`, input),
      remove: (id) => send("DELETE", `/chats/${id}`),
      markRead: (id) => send("POST", `/chats/${id}/read`),
      clear: (id) => send("POST", `/chats/${id}/clear`),
      addMembers: (id, memberIds) => send("POST", `/chats/${id}/members`, { memberIds }),
      removeMember: (id, contactId) => send("DELETE", `/chats/${id}/members/${contactId}`),
      messages: (id, query) =>
        get<MessagePage>(`/chats/${id}/messages`, { before: query?.before, limit: query?.limit }),
    },
    messages: {
      send: (chatId, input) => send<MessageDto>("POST", `/chats/${chatId}/messages`, input),
      edit: (id, text) => send("PATCH", `/messages/${id}`, { text }),
      remove: (id, scope) => request("DELETE", `/messages/${id}`, { query: { scope } }),
      toggleReaction: (id, emoji) => send("PUT", `/messages/${id}/reaction`, { emoji }),
      forward: (id, chatIds) => send("POST", `/messages/${id}/forward`, { chatIds }),
    },
    statuses: {
      list: () => get("/statuses"),
      create: (input) => send("POST", "/statuses", input),
      remove: (id) => send("DELETE", `/statuses/${id}`),
      markSeen: (id) => send("POST", `/statuses/${id}/seen`),
    },
    uploads: {
      create: (file, meta) => {
        const form = new FormData();
        form.append("file", file, meta.name);
        if (meta.width) {
          form.append("width", String(meta.width));
        }
        if (meta.height) {
          form.append("height", String(meta.height));
        }
        return request<AttachmentDto>("POST", "/uploads", { form });
      },
    },
  };
}
