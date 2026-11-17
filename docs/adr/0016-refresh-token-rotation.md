# 0016. Short access tokens, rotating refresh tokens in a cookie

- Status: accepted. The web app's side is in [ADR 0011](0011-session-handling-in-the-web-app.md).
- Date: 2026-11-17, recorded after the decision was implemented

## Context

The browser app needs a session that survives a reload, cannot be read by a script injected into the page, and
can be ended from the server. It also has to authenticate a WebSocket, which cannot send cookies across origins
in the way a REST call can.

## Decision

- **Access token:** a JWT, 15 minutes by default (`ACCESS_TOKEN_TTL_SECONDS`), returned in the response body
  and held in memory by the client. It authenticates REST calls and the socket handshake (`auth.token`). The
  server closes a socket at its token's expiry and the client reconnects with a fresh one.
- **Refresh token:** 32 random bytes, base64url, 30 days by default (`REFRESH_TOKEN_TTL_DAYS`). Only its SHA-256
  hash is stored. It lives in an `httpOnly` cookie (`dt_refresh`) scoped to the auth routes, `Secure` in
  production, with `SameSite`, `Domain` and `Path` set from the environment.
- **Families and rotation.** A sign-in starts a family. Every `POST /auth/refresh` retires the token it was
  given and issues the next one in the same family. The token row is read `FOR UPDATE`, so two requests with the
  same token are serialised, and expiry is judged by the database's clock, so instances agree.
- **Reuse detection.** A retired token that comes back **after a 10 second window**
  (`REFRESH_REUSE_WINDOW_MS`) is treated as copied, and the whole family is revoked: the thief and the person
  are both signed out. Inside the window the token rotates normally, because two tabs or React StrictMode in
  development refresh at once and are not an attack ([edge cases #26](../edge-cases.md)).
- **Guests** get a refresh token that never outlives the guest (`least(now() + ttl, guest_expires_at)`), and an
  expired guest's family is revoked on the next refresh.
- **Cross-site requests.** `refresh` and `logout` are the only routes that trust the cookie, so they sit behind
  `SameSite` and a second lock: a browser request whose `Origin` is not in `CORS_ORIGINS` is `403`
  ([edge cases #28](../edge-cases.md)). A request with no `Origin` passes, since that is not a cross-site page.
- **Passwords** are hashed with Argon2id. Login and guest creation are throttled per IP (and login per email)
  in Redis, so the limit holds across API instances.
- **Same origin in production.** The web app proxies `/api/*` to the API (a Next.js rewrite), which makes the
  cookie first party. The socket connects straight to the API with the access token and needs no cookie.

## Alternatives considered

- **A long-lived JWT in `localStorage`.** Any script on the page can read it, and it cannot be revoked before it
  expires.
- **Server-side sessions only.** Works for REST, but each WebSocket handshake and each API instance would need a
  session lookup, and the design would not carry over to a mobile client.
- **Rotation without reuse detection.** A stolen token would work until the real owner next refreshed. With
  detection, whichever of the two uses a retired token second ends the family.
- **Hash with Argon2 instead of SHA-256.** The token is 256 random bits, so there is nothing to brute-force and a
  slow hash would only cost CPU on every refresh.

## Consequences

- Signing out in one tab ends the family, but other tabs keep working until their access token expires (at
  most 15 minutes). A broadcast between tabs would end them at once. It is not built ([edge cases #98](../edge-cases.md)).
- The client must share one in-flight refresh between callers (`session-manager.ts`), or its own parallel
  requests would look like reuse once the window passes.
- The reuse window is a trade. A copied token replayed **within 10 seconds** of the real owner's refresh is not
  detected: it rotates normally and the family then has two live branches, one held by each side. Nothing
  flags that. Detection starts again once a retired token is presented after the window, so the attack needs the
  copy and the replay to happen almost at once. The window is configurable down to `0` for a deployment that would
  rather sign out an occasional double refresh than accept this.
