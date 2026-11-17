# 0011. Session handling in the web app

- Status: accepted
- Date: 2026-11-15

## Context

The web app used to run only on a mock server and kept its access token in `localStorage`. The real API
([API.md](../API.md)) issues two credentials: a 15-minute access token in the response body, and
a 30-day refresh token in an `httpOnly` cookie that is rotated on every use, where reusing an old one ends
the whole login family. The web app has to turn that into one continuous session across page loads, tabs
that go to sleep, a server that restarts and a socket that is turned away at the handshake. The mock has to
keep working with the same code, because `NEXT_PUBLIC_API_URL` empty is still a supported mode.

## Decision

**The access token lives in memory only.** `lib/stores/session.ts` holds it in a Zustand store and nothing
writes it anywhere. Script on the page can read `localStorage`, and a token that lives for 15 minutes
costs little to lose. The old `dovetalk:token` key is deleted on load so a copy from an earlier version
cannot linger.

**A page load starts signed out and asks the cookie.** `SessionWatcher` runs `restore()` once, which calls
`POST /auth/refresh` (with `credentials: "include"`). Until it finishes the app shows a loading screen
(`hydrated` is false), because "signed out" and "not asked yet" would otherwise look the same and send
people to the login page for a moment on every reload. There are three outcomes:

- `refreshed`: the cookie was good. We have a token and the user.
- `signed-out`: the server said 401 or 403 (no cookie, expired, used twice, or an origin it does not
  allow). Nobody is signed in here.
- `unavailable`: the server could not be reached or answered 5xx. This is **not** treated as signed out:
  the person keeps their session and sees a "Try again" screen. Signing them out because of a network
  blip would throw away a valid cookie.

**Refresh is single-flight.** `session-manager.ts` keeps one refresh promise and hands it to every caller.
This matters because the cookie rotates: two concurrent refreshes would present the same cookie twice, the
second would look like reuse, and the server would revoke the family and sign the person out. A burst of
requests that all fail with 401 therefore causes one rotation. A request that finds the token already
changed since it was sent does not refresh at all, it just retries with the new one (`http.ts`).

**Renewal is proactive, and 401 is the safety net.** The manager reads `exp` from the JWT and renews 60 s
before it (never sooner than 5 s from now), so most requests never meet an expired token. If a request is
refused anyway, `http.ts` refreshes once and retries once. A second 401, or a `signed-out` outcome, clears
the session. `/auth/*` calls never trigger a refresh themselves, so a wrong password is a normal error and
not a sign-out. When the server is unreachable the timer retries every 30 s, and the token is kept.
Tokens that are not JWTs (the mock's) have no `exp` and are never renewed.

**The socket follows the same rules.** `auth` is a callback, so every connection attempt sends the current
token. On `connect_error` with `data.code === "UNAUTHORIZED"` the client refreshes through the same
single-flight function and reconnects (socket.io does not retry a refused handshake, see API.md). On
`SHUTTING_DOWN`, `SERVER_ERROR` or a close by the server it backs off from 1 s, doubling to 10 s, because a
draining instance or a restarting database is exactly when every client would otherwise retry at once.
After a reconnect the app refetches chats, the open chat and contacts, as before.

**REST goes through the web app's own origin; the socket does not.** `NEXT_PUBLIC_API_URL=/api` and a Next
`rewrites` rule send `/api/*` to the API (`API_PROXY_TARGET`). The refresh cookie is then first-party,
which browsers that block third-party cookies still send. The API sets its path to `/api/auth`
(`COOKIE_PATH`) so the browser sends it to `/api/auth/refresh` and nowhere else, and it trusts one proxy
hop (`TRUST_PROXY=1`) so rate limits see the visitor and not the web server. The socket does not need the
cookie, because it authenticates with the access token in the handshake, so it connects straight to the API
and the web server does not carry every realtime connection. That is why a relative API URL requires an
explicit `NEXT_PUBLIC_WS_URL` (`resolveEndpoints` throws without it), and why the API's `CORS_ORIGINS` must
list the web origin: the socket handshake and the refresh call both send an `Origin` header.

**`NEXT_PUBLIC_*` and `API_PROXY_TARGET` are build-time settings.** Next inlines `NEXT_PUBLIC_*` into the
client bundle and bakes the rewrite into the build manifest, so changing them needs a rebuild. In Docker
they are build arguments of `apps/web/Dockerfile`. The cost is that one image serves one deployment; the
benefit is that nothing about the API address is fetched at runtime, and a missing proxy target stops the
build (`next.config.mjs` throws) and a missing socket address stops the app at startup, rather than
producing a page that cannot sign in. The Compose `web` service pins port 3000 for the same
reason: the API's default `CORS_ORIGINS` is `http://localhost:3000`, so a `WEB_PORT` override would break
sign-in unless the two were changed together.

**The mock holds one account and a stand-in for the cookie.** `register` and `guest` replace the account in
the mock's storage; signing in as `demo@dovetalk.app` restores the demo data. A saved flag
(`MockStorage.loadSession` and `saveSession`) plays the part of the `httpOnly` cookie, so reloading in mock
mode restores the session through the same `restore()` path as the real API. One account at a time is
enough to demonstrate every flow, and it avoids inventing a multi-account store that the real backend does
the work of.

## Consequences

- A reload costs one request (`/auth/refresh`) before the app shows anything, and a cookie rotation per
  tab. Two tabs reloading at the same moment can race on the cookie; the API's reuse window
  (`REFRESH_REUSE_WINDOW_MS`, default 10 s) is what keeps that from ending the login (edge case 90).
- A tab that was asleep or throttled for a long time can come back with an expired token because its
  renewal timer did not run. The next request gets a 401, and the single refresh-and-retry path repairs it
  without the person noticing (the same path as the second check below).
- Signing out in one tab does not end the others straight away. Their token works until it expires, and
  then their refresh fails with 401 and they are signed out. A broadcast between tabs could close this
  gap; it is not built.
- The unit tests cover the timers and races with a fake clock. Nothing in CI waits for a real token to
  expire, so the live paths were run by hand in a real browser (Chromium, web app through `/api`) against a
  stack started natively (the standalone web build, API, worker, Postgres 16, Redis and SeaweedFS), because
  Docker was not available:
  - *Proactive renewal.* With `ACCESS_TOKEN_TTL_SECONDS=90`, the page renewed at 30 s, 60 s and 90 s,
    no request got a 401, the server closed the socket at the first token's expiry and it reopened a
    second later with the new token. A message sent and one received 25 s after that expiry both worked.
  - *The 401 safety net.* With the API restarted on a different `JWT_SECRET` (every in-memory token
    invalid, the cookie still good), a send and the socket's reconnect together caused exactly one
    `POST /auth/refresh` (200). The message was delivered, a message from the other person arrived live,
    and nobody was signed out.

## Alternatives considered

- **Keep the token in `localStorage`.** Simplest, and survives reloads without a request, but any script
  on the page can steal a token that works for 15 minutes and, with the refresh endpoint, longer.
- **Only the cookie, no access token (a session cookie the API reads).** Removes token handling from the
  client, but the socket handshake and a future non-browser client would still need a token, and it makes
  CSRF protection a requirement on every write endpoint.
- **A cross-site cookie (`SameSite=None; Secure`) with the web app calling the API directly.** Works
  without a proxy, but browsers increasingly block third-party cookies, and it would fail on the plain
  `http://localhost` used for development. The proxy keeps it first-party everywhere.
- **Proxy the socket too.** It would put every realtime connection through the web server for no gain,
  since the token in the handshake already authenticates it, and it would tie the web server's scaling
  to the number of open sockets.
