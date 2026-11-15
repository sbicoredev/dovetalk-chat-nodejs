# Dovetalk

The web client of Dovetalk, built with Next.js, Tailwind CSS and Base UI. It runs in one of two modes, chosen when the app is built:

- **Mock mode** (the default, `NEXT_PUBLIC_API_URL` empty): an in-browser server with dummy data, saved in your browser (localStorage). No backend needed. Sign in with `demo@dovetalk.app` / `dovetalk123`, create an account, or choose Try the demo. In Settings, Reset demo data starts over. The mock holds one account at a time.
- **Real mode** (`NEXT_PUBLIC_API_URL=/api`): the same app talks to the NestJS API and its socket.io server, through the web app's own `/api` path. Create an account, sign in, or choose Try the demo (a guest account with the demo chats). Reset demo data is hidden.

Run commands from the repository root (the repo is a pnpm workspace, Node 26 and pnpm 12).

## Run it

Mock mode:

```bash
pnpm install
pnpm --filter @dovetalk/web dev      # http://localhost:3000
```

Against the real backend, the quickest way is Docker: `docker compose --profile app up -d --build` from the repository root starts everything, including this app, on http://localhost:3000. To run only this app against an API you started yourself, see the next section. Use `pnpm --filter @dovetalk/web build` and `start` for a production build, and `pnpm --filter @dovetalk/web test` to run the tests.

## What works

**Messages**

- Send text, emoji, voice messages (record, send, play back with a waveform), photos and files.
- Message menu: react with emoji, reply (with a quote you can click to jump back), copy text, forward to one or more chats, edit your own messages, delete for me, delete for everyone.
- Photos open in a viewer with a download link. Files download from the bubble. Photos are scaled down and uploaded first, then sent by id. In demo mode files are capped at 1.5 MB so they fit in browser storage.
- Messages show right away and are marked "Sending". If sending fails you get Retry and Discard. History loads in pages as you scroll up.
- A typing indicator and an automatic reply a couple of seconds after you send, with an optional chime.

**Chats**

- Search the chat list, and search inside a chat with match highlighting and next/previous.
- Pin up to 3 chats, mute chats, archive, clear messages, delete.
- New chat and Create group. Group info lets you rename the group and add or remove members.

**Contacts**

- Searchable alphabetical list, contact details, add, edit, block, unblock and delete (with confirmation).
- Blocked contacts can't be messaged or called, and they stop auto-replying.

**Status and calls**

- Status stories row with a viewer (tap, arrow keys, Escape) and Add status. You can delete your own statuses.
- Simulated voice and video call screens. No audio or video is sent anywhere.

**Settings and profile**

- Profile name, about line and photo, message sounds, message previews, Enter-to-send, blocked contacts list, and Reset demo data.
- Light and dark mode, following the system by default.
- Two panes on desktop, and a single pane with a bottom bar on phones.

## Running against the API

The browser calls the API through this app, at `/api`, and opens the socket straight on the API. Copy `.env.example` to `.env.local` and set:

```bash
NEXT_PUBLIC_API_URL=/api
NEXT_PUBLIC_WS_URL=http://localhost:3001   # where the browser opens the socket
API_PROXY_TARGET=http://localhost:3001     # where this server reaches the API
```

Then start the API (and the worker, which makes the bots answer) and run `pnpm --filter @dovetalk/web dev`. The API needs three settings for this setup:

- `COOKIE_PATH=/api/auth`, so the browser sends the sign-in cookie to `/api/auth/refresh`.
- `CORS_ORIGINS=http://localhost:3000`, the origin of this app. The socket and the refresh call send an `Origin` header.
- `TRUST_PROXY=1`, so its rate limits see the visitor and not this server.

Why it is built this way: with the proxy the sign-in cookie belongs to the same site as the page, so browsers that block third-party cookies still send it. The socket cannot use the cookie and does not need to, because it signs in with the access token. See [ADR 0011](../../docs/adr/0011-session-handling-in-the-web-app.md).

**All three variables are read when the app is built**, not when it starts. Change one and rebuild (`next build` or a new Docker build; in Compose they are build arguments of the `web` service). A relative `NEXT_PUBLIC_API_URL` without `API_PROXY_TARGET` stops the build, and without `NEXT_PUBLIC_WS_URL` the app throws when it starts. A full URL such as `NEXT_PUBLIC_API_URL=http://localhost:3001` also works if the API sets `COOKIE_SAMESITE=none` and `COOKIE_SECURE=true`, but browsers may block that cookie as a third party's, so `/api` is the supported setup.

The API's endpoints and socket events are in [`docs/API.md`](../../docs/API.md). The payload types are in `packages/contracts`. The mock server and the HTTP client both implement the `Api` interface, so you can compare them side by side.

## Signing in and staying signed in

The access token (15 minutes) lives in memory only. The long sign-in is an `httpOnly` cookie that scripts cannot read. When the page loads, the app asks `/auth/refresh` for a token (a loading screen shows until that answers). It renews the token a minute before it expires, and if a request still gets a 401 it refreshes once and tries again. If the server cannot be reached, the app keeps the session and offers Try again instead of signing out. The socket follows the same rules. Details and the reasons are in [ADR 0011](../../docs/adr/0011-session-handling-in-the-web-app.md).

## Structure

```
src/
  app/                 Routes: /login, /, /chat/[id], /contacts, /contacts/[id], /archive
  components/          App shell, panels, conversation, composer, message bubble, dialogs
    auth/              Login form (sign in, create account, try the demo) and the gate that guards the app
    ui/                Button, input, avatar, switch, modal (Base UI Dialog), menu (Base UI Menu)
  lib/
    api/               The contract: types.ts (DTOs), api.ts (interfaces), errors.ts
      http.ts          fetch client for the real REST API (one refresh and retry on a 401)
      socket.ts        socket.io client (refreshes on UNAUTHORIZED, backs off when the server is busy)
      endpoints.ts     Works out the API and socket addresses from the environment
      mock/            In-browser server: seed data, rules, real-time events, storage
      conformance/     One behaviour suite that runs against the mock and the real API
      index.ts         Chooses mock or real from the environment
    queries/           TanStack Query: keys, queries, mutations (optimistic updates), cache helpers
    realtime/          Applies socket events to the query cache
    stores/            Zustand: session (the in-memory token) and ui (dialogs, toast, typing, connection)
    auth/              The signed-in user (useMe()) and the session manager that restores and renews the sign-in
    files.ts           Resizes photos and avatars before upload
  test/                Shared test helpers
e2e/                   Playwright tests that drive real browsers against the whole stack
```

Server data lives in TanStack Query. Zustand holds only screen state and the in-memory token.

## Tests

`pnpm --filter @dovetalk/web test` runs Vitest: the HTTP client (including the refresh and retry on a 401), the socket client (reconnect rules), the session manager (single-flight refresh, renewal timers, restore), the mock server (auth, paging, idempotent sends, blocking, pin limit, edit, delete, reactions, forwarding, uploads, real-time events), the socket-event handler, and the mutation hooks (optimistic send, failure and retry, rollback). The behaviour suite in `src/lib/api/conformance` runs against the mock there.

**Conformance against a real API.** With the API and the worker running and `RATE_LIMIT_*` raised (every test signs up its own account): `CONFORMANCE_BASE_URL=http://localhost:3001 pnpm --filter @dovetalk/web test:conformance`.

**End-to-end.** Playwright drives Chromium against the whole stack: signing up, staying signed in across a reload, two people chatting live (typing, delivery, a reaction), a bot's reply, profile photo, photo and file messages with download, forwarding, live group changes and the address book. Start the real-mode stack first (`docker compose --profile app up -d --build` from the repository root, which serves this app on http://localhost:3000), then:

```bash
pnpm --filter @dovetalk/web exec playwright install chromium
pnpm --filter @dovetalk/web test:e2e
```

Set `E2E_BASE_URL` for another address, and `E2E_CHROMIUM_PATH` to use a Chromium you already have. The API's rate limits must be raised (the Compose file reads `RATE_LIMIT_*` from `.env`; CI sets them to a million). The mock cannot run these tests: they need two real accounts and a worker.

## Notes

- In real mode no token is ever written to storage. In mock mode only the mock's data and a "signed in" flag are, in `localStorage`.
- Uploads go through the `/api` proxy. Next caps a proxied request body at 10 MiB; the API's limit is 10 MB, and the composer checks it before uploading ([edge case 95](../../docs/edge-cases.md)).
- In-chat search covers the messages loaded so far. The chat list search matches titles and the latest message.
- Fonts (Bricolage Grotesque and Figtree) come from npm packages, so no network request is made at build time.
