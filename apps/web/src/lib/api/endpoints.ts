export interface Endpoints {
  /** Where REST calls go: absolute ("http://localhost:3001") or a path on this site ("/api"). */
  apiUrl: string;
  /** Where the socket connects. Always absolute. */
  wsUrl: string;
}

/**
 * Works out where the real backend is, from `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_WS_URL`.
 * Returns null when no API URL is set, which means the in-browser mock server is used.
 *
 * REST can go through a proxy on the web app's own origin (`NEXT_PUBLIC_API_URL=/api`, with a
 * Next.js rewrite), which keeps the refresh cookie first-party. The socket cannot: it connects
 * straight to the API, so with a relative API URL its address has to be given.
 */
export function resolveEndpoints(apiUrl: string, wsUrl: string): Endpoints | null {
  const api = apiUrl.trim();
  const ws = wsUrl.trim();
  if (!api) {
    return null;
  }
  if (ws) {
    return { apiUrl: api, wsUrl: ws };
  }
  if (api.startsWith("/")) {
    throw new Error(
      `NEXT_PUBLIC_API_URL is "${api}", a path on this site, so NEXT_PUBLIC_WS_URL must say where the socket is (for example http://localhost:3001).`,
    );
  }
  return { apiUrl: api, wsUrl: new URL(api).origin };
}
