# Dovetalk API contract

The web app talks to a backend through one interface (`src/lib/api/api.ts`). Two implementations exist:

- **Mock** (`src/lib/api/mock`): runs in the browser with demo data. Used when `NEXT_PUBLIC_API_URL` is empty. It implements the whole interface, including `register`, `guest` and `refresh`. It holds **one account at a time**: `register` and `guest` replace it, and signing in as the demo account brings the demo data back. A flag in its storage stands in for the refresh cookie, so a reload restores the session the way the real API does ([ADR 0011](adr/0011-session-handling-in-the-web-app.md)).
- **HTTP + socket.io** (`src/lib/api/http.ts`, `socket.ts`): used when `NEXT_PUBLIC_API_URL` is set.

All payload types live in `packages/contracts` (`@dovetalk/contracts`), shared by the web app and the backend.

> **Source of truth.** For the server, the generated OpenAPI document at `/docs` is authoritative. When this file and the mock server (`apps/web/src/lib/api/mock/server.ts`, with its tests) disagree, the mock and its tests win. See [edge-cases.md](edge-cases.md) for decisions that differ from the mock.

## Conventions

- JSON everywhere. Timestamps are Unix epoch **milliseconds**. Ids are opaque strings.
- `senderId` uses the same id space as `MeDto.id` and `ContactDto.id`. `"system"` marks notices such as "You created this group".
- Nullable fields are always present as `null`. Maps such as `reactions` are always objects.
- Auth: `Authorization: Bearer <accessToken>` on every request except the `/auth/*` routes and `/health/*`. See [Authentication](#authentication).
- Errors: any non-2xx response has the body `{ statusCode, code, message }`. `message` is a string, or an array of strings for `VALIDATION_ERROR`. Codes the UI relies on:

| Status | `code`                                                                                             | Meaning                                                                                                              |
| ------ | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 401    | `UNAUTHORIZED`                                                                                     | Token missing or expired. The client signs the user out.                                                             |
| 401    | `INVALID_CREDENTIALS`                                                                              | Login failed. Shown inline on the form.                                                                              |
| 403    | `CONTACT_BLOCKED`                                                                                  | Sending to a blocked contact.                                                                                        |
| 403    | `FORBIDDEN`                                                                                        | Editing or deleting someone else's message, or removing someone from a group you did not create.                     |
| 404    | `CHAT_NOT_FOUND`, `CONTACT_NOT_FOUND`, `MESSAGE_NOT_FOUND`, `STATUS_NOT_FOUND`, `MEMBER_NOT_FOUND` | Missing resource.                                                                                                    |
| 409    | `PIN_LIMIT`                                                                                        | More than 3 pinned chats. Archived chats count.                                                                      |
| 413    | `FILE_TOO_LARGE`                                                                                   | Upload over the limit.                                                                                               |
| 400    | `INVALID_CURSOR`                                                                                   | Unknown `before` id.                                                                                                 |
| 422    | `VALIDATION_ERROR`, `ATTACHMENT_NOT_FOUND`                                                         | Bad input. A `\0` (NUL) character anywhere in a JSON body is `VALIDATION_ERROR` ([edge case 12](edge-cases.md)).     |
| 409    | `EMAIL_TAKEN`, `PHONE_TAKEN`                                                                       | Sign-up or profile uses an email or number that is taken, or a contact is given the number of another saved contact. |
| 429    | `RATE_LIMITED`                                                                                     | Too many attempts. See the `Retry-After` header.                                                                     |
| 400    | `BAD_REQUEST`                                                                                      | A request that is not valid JSON.                                                                                    |
| 413    | `PAYLOAD_TOO_LARGE`                                                                                | A JSON body over 100 kB. Uploads use `FILE_TOO_LARGE`.                                                               |
| 404    | `NOT_FOUND`                                                                                        | No such route.                                                                                                       |
| 500    | `INTERNAL_ERROR`                                                                                   | Unexpected. The message never says what went wrong.                                                                  |

## Authentication

- `POST /auth/register`, `/auth/login` and `/auth/guest` return `{ accessToken, user }` and set the refresh cookie `dt_refresh`.
- The **access token** is a JWT valid for 15 minutes. Keep it in memory and send it as `Authorization: Bearer`. It carries only the user id.
- The **refresh token** is an opaque random value in an `HttpOnly` cookie scoped to the auth routes (`COOKIE_PATH`). `POST /auth/refresh` exchanges it for a new access token and a new cookie. Every refresh retires the token that was used. An old token used again within 10 seconds is accepted, because two tabs can refresh at once. After that it means the cookie was copied, and the whole sign-in is revoked ([edge case 26](edge-cases.md)).
- `POST /auth/refresh` and `POST /auth/logout` refuse a browser request whose `Origin` is not in `CORS_ORIGINS` (403 `FORBIDDEN`). Requests with no `Origin` header (curl, mobile apps) pass.
- `POST /auth/logout` needs no access token and ends the sign-in on this device. Calling it twice is fine.
- Guests have a generated address on `guest.dovetalk.invalid`, no password, and cannot sign in again. Their sign-in never outlives the guest.
- Passwords are 8 to 128 characters. Sign-in, sign-up, guest creation and refresh are rate limited. Login is limited per IP and per email address.

### The demo account

`demo@dovetalk.app` with the password `dovetalk123` exists only where `pnpm db:seed` ran with `SEED_DEMO_ACCOUNT=true` ([edge case 31](edge-cases.md)).

### Conformance

The behaviour tests in `apps/web/src/lib/api/conformance/suite.ts` run against the mock on every `pnpm test`, and against a live API with `pnpm --filter @dovetalk/web test:conformance`. The mock still wins when a test and this file disagree. The real API runs every area, 53 of 53 tests (they include register, guest, refresh and logout), provided the worker is running: the `bots` test (the worker's typing and reply) fails with "No reply arrived" without it. Where the real API differs from the mock on purpose ([below](#where-the-real-api-differs-from-the-mock)), the behaviour is documented here and kept out of the shared suite.

## REST endpoints

All REST endpoints are built, and every write path announces its change over [the socket](#real-time-socketio) after the transaction commits. Searching a chat's full history (`GET /chats/:id/messages?q=`) is not built: it is optional (see [Search](#search)).

| Method and path                        | Body or query                                  | Returns                                                                                          |
| -------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `POST /auth/register`                  | `{ email, password, name, phone? }`            | `201 { accessToken, user: MeDto }`                                                               |
| `POST /auth/login`                     | `{ email, password }`                          | `{ accessToken, user: MeDto }`                                                                   |
| `POST /auth/guest`                     |                                                | `201 { accessToken, user: MeDto }`. Expires in 24 hours.                                         |
| `POST /auth/refresh`                   | refresh cookie                                 | `{ accessToken, user: MeDto }`                                                                   |
| `POST /auth/logout`                    | refresh cookie                                 | 204                                                                                              |
| `GET /me`                              |                                                | `MeDto`                                                                                          |
| `PATCH /me`                            | `UpdateMeInput` (`preferences` merges)         | `MeDto`                                                                                          |
| `GET /contacts`                        |                                                | `ContactDto[]`. Includes `saved: false` people, see [Contacts](#contacts).                       |
| `POST /contacts`                       | `{ name, phone }`                              | `201 ContactDto` for a new contact, `200` if you already had one with that number.               |
| `PATCH /contacts/:id`                  | `{ name?, phone?, about? }`                    | `ContactDto`                                                                                     |
| `DELETE /contacts/:id`                 |                                                | 204. Un-saves the contact and removes the direct chat from your list.                            |
| `PUT /contacts/:id/block`              | `{ blocked: boolean }`                         | `ContactDto`                                                                                     |
| `GET /chats`                           |                                                | `ChatDto[]` (with `lastMessage` and `unread`)                                                    |
| `POST /chats`                          | `CreateChatInput`                              | `201 ChatDto` for a new chat, `200` for a direct chat that exists or was revived.                |
| `PATCH /chats/:id`                     | `{ archived?, pinned?, muted?, name? }`        | `ChatDto`                                                                                        |
| `DELETE /chats/:id`                    |                                                | 204                                                                                              |
| `POST /chats/:id/read`                 |                                                | 204                                                                                              |
| `POST /chats/:id/clear`                |                                                | 204                                                                                              |
| `POST /chats/:id/members`              | `{ memberIds }`                                | `200 ChatDto` (not 201). Ignores people already in the group and ids that are not your contacts. |
| `DELETE /chats/:id/members/:contactId` |                                                | `200 ChatDto`. Only the group's creator. A group keeps at least two other members.               |
| `GET /chats/:id/messages`              | `?before=<messageId>&limit=<n>`                | `{ items, nextCursor }`. See [Message paging](#message-paging).                                  |
| `POST /chats/:id/messages`             | `SendMessageInput`                             | `201 MessageDto`, or `200` with the stored one if `clientId` was already used.                   |
| `PATCH /messages/:id`                  | `{ text }`                                     | `MessageDto` (`edited: true`)                                                                    |
| `DELETE /messages/:id`                 | `?scope=me\|everyone`                          | 204. `everyone` leaves a tombstone (`deleted: true`).                                            |
| `PUT /messages/:id/reaction`           | `{ emoji }`                                    | `MessageDto`. Toggles the current user's reaction.                                               |
| `POST /messages/:id/forward`           | `{ chatIds }`                                  | `201 MessageDto[]`, in the order of `chatIds`. See [Message actions](#message-actions).          |
| `GET /statuses`                        |                                                | `StatusDto[]`. See [Statuses](#statuses).                                                        |
| `POST /statuses`                       | `{ text, color }`                              | `201 StatusDto`                                                                                  |
| `DELETE /statuses/:id`                 |                                                | 204                                                                                              |
| `POST /statuses/:id/seen`              |                                                | 204                                                                                              |
| `POST /uploads`                        | multipart: `file`, `name`, `width?`, `height?` | `201 AttachmentDto`. See [Uploads](#uploads).                                                    |

### Message paging

`GET /chats/:id/messages?limit=25` returns the **newest** page. `items` are oldest first. Pass `nextCursor` back as `before` to get the page of older messages. `nextCursor` is `null` on the last page, which is also when `limit` is at least the number of messages left.

- `limit` defaults to 25. A value of 0 or below is raised to 1 and a value above 100 is cut to 100.
- An empty `before=` or `limit=` means "not sent".
- A `before` that is not a message of this chat (unknown, malformed, or from another chat) is `400 INVALID_CURSOR`.
- Real API only: a `limit` that is not a whole number (`abc`, `2.5`) and a repeated `before` or `limit` are `422 VALIDATION_ERROR`. The mock does not check.
- History starts at the point the viewer cleared the chat, deleted it, or joined the group. Older messages are never returned, even with a valid cursor.
- `clientId` in a `MessageDto` is present only for the person who sent the message, and `null` for everybody else.

### Contacts

- `GET /contacts` returns every contact row of the viewer, including people with `saved: false`: someone you share a chat with but never added, or a contact you deleted. They are listed so their messages can show a name. The web app hides them from the address book and the pickers and keeps them for names (`isSavedContact`, [edge case 94](edge-cases.md)). The mock always says `saved: true`.
- A phone number needs 7 to 15 digits, written with digits, a leading `+`, spaces and `( ) . -` only. Numbers are matched on their digits, nothing else: there is no country normalisation, so `(555) 010-0142` and `+1 555 010 0142` are different numbers, while `+1 (555) 010-0142` and `+1 555 010 0142` are the same. The server stores the number as typed, so compare digits in the client.
- `POST /contacts`: your own number is `422 VALIDATION_ERROR`. If you already have a contact with the same digits, it is returned with `200` (and re-saved, with the new name, if it was unsaved). Otherwise a registered user with that number is linked, and any other number becomes a ghost bot that belongs to you alone and answers like the seeded contacts. A real person who registers with that number later is not linked automatically (roadmap).
- `PATCH /contacts/:id`: giving a contact the number of **another saved** contact is `409 PHONE_TAKEN`. Your own number is `422`. Unsaved contacts do not count. `about` and `name` are trimmed, an empty `name` is `422`. `about`, avatar and hue fall back to the linked person's live profile until you change them.
- `DELETE /contacts/:id` un-saves the contact, hides your direct chat with them and ends its history, and keeps the block flag. It is `404 CONTACT_NOT_FOUND` for a contact that is already unsaved. It does **not** remove them from groups or delete their statuses: you keep seeing a status of anyone you have a contact row for ([edge case 38](edge-cases.md)). The number of contacts is not limited.
- `PUT /contacts/:id/block` takes `{ blocked: boolean }` (anything else is 422) and is repeatable. What a block does to sending is in [Messages](#messages).
- Another person's contact id is `404 CONTACT_NOT_FOUND`, never 403, so ids reveal nothing.

### Chats

- `GET /chats` runs a constant number of queries however many chats there are (asserted over HTTP). It is ordered by chat creation, newest first. The client orders by activity. `lastMessage` is the newest message visible to the viewer.
- `POST /chats` with a direct chat is race-safe: both people opening it at once end up in one chat. Opening a chat you deleted brings the same chat back, empty, with `unread: 0`. A chat that is hidden for you is `404` everywhere else.
- A group needs a name of 1 to 60 characters (trimmed) and at least two other people who are your contacts, at most 255. Unknown and duplicate ids are dropped before the count. The creator gets the system note "You created this group", and other members see "Alex created this group".
- `PATCH /chats/:id`: pin, archive and mute are per person. Pinning counts your pinned chats that are on your list, archived ones included, under a lock, so two requests cannot pass the limit of 3. Renaming a direct chat, or to an empty name, is `422`. Renaming to the current name changes nothing and writes no note.
- `DELETE /chats/:id` and `POST /chats/:id/clear` only affect the viewer. Clear keeps the chat on the list with its pin, archive and mute flags, sets `unread` to 0 and leaves no messages. Delete also resets the flags.
- Members: any member may add people, and people added later read the chat only from the moment they joined. Only the person who created the group may remove someone. The checks run in this order: chat visible (404 `CHAT_NOT_FOUND`), is a group (422), you are the creator (403 `FORBIDDEN`), they are in the group (404 `MEMBER_NOT_FOUND`), at least two others would remain (422). Adding or removing writes a system note: "You added Priya and Tobias", "Alex added you and Priya", "You removed Priya". Someone who cannot be named reads as "Someone" or "someone".
- System messages (`kind: "system"`) are stored as events and written out per viewer. `text` is the rendered sentence in the API. The database does not forbid text on a system message, the message store does.
- Another person's chat id is `404 CHAT_NOT_FOUND`, with the same body as an unknown id. Ids that are not ids at all are 404 too, never 500.

### Accounts start with data

A new account (register or guest) gets, in the same transaction as the account itself: 14 contacts linked to 14 shared bot users (deterministic ids from a fixed namespace), 11 chats (9 direct, 2 groups, 27 membership rows) and 153 messages with timestamps relative to the sign-up. The same transaction writes the prototype's 3 reactions and 6 statuses (notes of the shared bots, each meant for this one account, one of them already seen). A new account matches the mock's `createSeed` message for message, which was checked field by field. `pnpm db:seed` gives the demo account the same, including a demo account made before contacts existed, which has none. The bots are created once per database, and an instance remembers that: if the database is wiped while an instance runs, restart the instance.

### Where the real API differs from the mock

The mock is the spec, so these are the places where the real API was deliberately built differently. None of them is in the shared conformance suite.

| Topic                                                   | Mock                                                 | Real API                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Delete a contact                                        | Removes them from groups and deletes their statuses. | Keeps group membership and their statuses. The contact becomes `saved: false`.       |
| Remove a group member                                   | Anyone.                                              | Only the group's creator, else 403 `FORBIDDEN`.                                      |
| Create a contact with a number you already have         | Always adds a new contact.                           | Returns the existing one (200). Your own number is 422. A registered user is linked. |
| `PATCH` a contact to a number another saved contact has | Allowed.                                             | 409 `PHONE_TAKEN`.                                                                   |
| Open a direct chat after deleting it                    | A new chat with a new id.                            | The same chat, empty.                                                                |
| `limit` and `before` query strings                      | Not validated.                                       | Validated, see [Message paging](#message-paging).                                    |
| NUL character in a JSON body                            | Accepted.                                            | 422 on every route (also a password: 422, not 401).                                  |
| `ContactDto.saved`                                      | Always `true`.                                       | `false` for unsaved people.                                                          |
| Order of `GET /chats`                                   | Newest activity first.                               | Newest chat first.                                                                   |
| Forward to a chat that is not yours                     | Copies into the earlier chats, then fails.           | 404 and nothing is sent: one transaction, all or nothing.                            |
| `DELETE /messages/:id` without `scope`                  | Treated as `everyone`.                               | 422, so the wider delete is never the default.                                       |
| What an upload is                                       | The type the browser said.                           | The type read from the bytes. Only pictures show inline, everything else downloads.  |
| Upload limit and `AttachmentDto.url`                    | 1.5 MB by default. A data URL.                       | 10 MB. A signed link that stays valid for 1 to 2 hours (see [Uploads](#uploads)).    |
| Status expiry and who may see a status                  | No expiry, one user.                                 | Gone after 24 hours. One you cannot see is 404, one you can see but did not write is 403. |
| `POST /chats/:id/messages` answer code                  | Returns the message.                                 | 201 for a new message, 200 for a replay. The body is the same.                       |

### Messages

`POST /chats/:id/messages` takes `SendMessageInput`. Checks run in this order, as in the mock: the chat is visible (404 `CHAT_NOT_FOUND`), the `clientId` was not used before (a replay returns the stored message with `200` and changes nothing, even when the body differs), you have not blocked the contact (403 `CONTACT_BLOCKED`), the content (422), the attachment (422 `ATTACHMENT_NOT_FOUND`), the reply target (422).

- **Idempotency.** The client makes a UUID `clientId` for every message, 1 to 100 characters. The server echoes it in the `MessageDto` of the sender, so the client can replace its optimistic copy. A replay adds no message, counts no unread and emits no event. Five sends of one `clientId` at once end in one `201` and four `200`s.
- **Text** is trimmed. Empty is 422, over 4000 characters is 422. A `text` message has text and nothing else. A `voice` message needs `duration` of at least 1 second (rounded, at most a day) and may carry up to 200 waveform `bars` from 0 to 100. A picture or file needs `attachmentId` and may carry a caption, which is trimmed and cut at 4000 characters. Fields that do not belong to the kind are dropped, not refused.
- **Replies.** `replyToId` must be a message of this chat that you can see: otherwise 422. The preview in `replyTo` is computed when the message is read, so it follows edits and deletions, and reads as deleted when you cannot see the original.
- **Blocking.** If you blocked the contact of a direct chat, sending is 403 `CONTACT_BLOCKED` until you unblock. If *they* blocked *you*, your message is stored and you see it, but it is hidden from them for good: no unread, no event, the chat does not come back on their list, and it stays hidden if they unblock you later ([edge case 19](edge-cases.md)).
- **Order.** Each message takes the next `seq` of its chat inside the transaction that writes it, so concurrent senders never share one and a chat has no gap. `createdAt` comes from the database clock and never goes below the message before it.
- **Unread** is a counter per member, raised for everybody else in the same transaction and reset by `POST /chats/:id/read`. A chat a member had deleted comes back on their list (what they cleared stays cleared).

### Bot replies

Writing to a bot is answered by the worker, not by the request: `POST /chats/:id/messages` returns as it always did, and the answer arrives over the socket as `typing` (`isTyping: true`, after about 0.7 s), then `message:new` and `typing` with `isTyping: false` (after about 2.4 s). The real API follows the mock on all of it, and differs in these ways, which are why the behaviour is not asserted more tightly in the shared suite:

- **The worker must be running** and use the same `QUEUE_PREFIX` as the API. With `BOT_REPLIES_ENABLED=false` on the API, or no worker, bots stay quiet and nothing else changes.
- **Who answers.** Only a person's message sets a bot going, never a bot's. A direct chat is answered by its bot, unless you blocked it. A group is answered by one of its bots. The chat must still be on your list when the answer is due. At most one answer waits per chat: messages sent while one is pending get none ([edge case 24](edge-cases.md)).
- **The line is chosen from the message id**, not at random, so a retry says the same thing. The reply is sent under the `clientId` `bot-reply:{messageId}`, so a retried job is a replay and adds nothing. You never see it: the `clientId` is echoed only to the sender, and the sender is the bot, so `clientId` is `null` in the reply you read.
- **A late worker skips "typing".** If the worker was down past the moment the reply is due, only the reply (and `isTyping: false`) arrives. A client must not wait for `isTyping: true`.
- **Lost events.** The answer is stored before it is announced. If the worker is killed in between (SIGKILL, not a normal shutdown), the message is there on the next load but its `message:new` is never sent, like any event lost to a crash ([edge case 67](edge-cases.md)).
- The chat's unread count goes up and `chat:updated` follows, as for a message from a person.

### Message actions

All of these take a message id, wherever it is. A message you cannot see (unknown, malformed, in somebody else's chat, or hidden by you) is 404 `MESSAGE_NOT_FOUND`, never 403.

- `PATCH /messages/:id` edits the text of your own text message, or the caption of your own picture or file (an empty caption removes it). Somebody else's, or a system note, is 403 `FORBIDDEN`. A voice message or a deleted one is 422. The result has `edited: true`.
- `DELETE /messages/:id?scope=me|everyone`. `me` hides it from you only, whoever wrote it. `everyone` is the sender's alone (403 otherwise) and keeps a tombstone for every member: `deleted: true`, with the text, file, length, waveform, reactions, `forwarded` and `edited` cleared. Repeating `everyone` is fine. The file is removed once no other message (a forwarded copy) and no profile photo uses it ([edge case 13](edge-cases.md)). `scope` is required.
- `PUT /messages/:id/reaction` with `{ emoji }`. One reaction per person: the same emoji takes it back, a different one replaces it and goes to the back of the line. The value must be an emoji, 32 characters at most. A deleted message or a system note is 422.
- `POST /messages/:id/forward` with `{ chatIds }`, at most 20, repeats ignored. It copies the message into each chat as yours, with `forwarded: true`. The copy keeps the text, the voice `duration` and `bars`, and **shares the file** of the original. It drops the reply, the reactions and the `clientId`. The answer lists the copies in the order of `chatIds` and can be shorter than the list: a direct chat with somebody you blocked is skipped silently, as in the mock. A deleted message or a system note is 422. Any chat that is not yours is 404 and nothing is sent.
- `GET /chats/:id/messages` and the `lastMessage` of `GET /chats` leave out what you deleted for yourself and what was sent to you after you blocked the sender. Paging stays whole when a hidden message sits on a page boundary or is the cursor.

### Statuses

Short notes that disappear after 24 hours.

- `GET /statuses` returns your own and those of everybody you have a contact row for, oldest first, none expired. The database clock decides expiry, so API instances cannot disagree. `ownerId` follows the same rule as `senderId`: your own user id for your notes, otherwise your contact id for the author. `seen` is `true` for your own.
- `POST /statuses` takes `{ text, color }`. `color` is a whole number from 0 to 5, else 422. `text` is trimmed, empty is 422, and one over 120 characters is cut, not refused (counting code points, so an emoji is never split).
- `DELETE /statuses/:id` deletes your own. A status you cannot see (unknown, malformed, expired, or somebody else's out of reach) is 404 `STATUS_NOT_FOUND`. One you can see but did not write is 403 `FORBIDDEN`.
- `POST /statuses/:id/seen` is `204` and repeatable. It changes nothing for your own, and is 404 for one you cannot see.

### Uploads

1. `POST /uploads` as `multipart/form-data`: the file in the field `file`, and optionally `name`, `width` and `height` (pictures only, 1 to 20000). Get an `AttachmentDto`.
2. Use its `id` as `attachmentId` in `POST /chats/:id/messages` (`kind: "image" | "file"`), or as the photo in `PATCH /me`.

- The limit is 10,000,000 bytes: `413 FILE_TOO_LARGE`. An empty file, a missing file or a bad `width` or `height` is 422 `VALIDATION_ERROR`. The web app checks the size before it uploads.
- What the file is comes from its bytes. The type the client claimed is believed only for plain text, CSV, Markdown and JSON, which have no signature ([edge case 18](edge-cases.md)). A `kind: "image"` message with a file that is not a picture is 422 and keeps the upload usable.
- Files are stored under `uploads/{ownerId}/{id}`. `url` is a signed link for the browser to load, made when the DTO is built and never stored. It is signed from the start of the hour, so every response in that hour has the same link, and one is valid for at least an hour ([edge case 16](edge-cases.md)). Pictures are served inline. Everything else is an opaque download with the original name in `Content-Disposition` ([edge case 17](edge-cases.md)). `S3_PUBLIC_ENDPOINT` must be reachable from the browser.
- An upload can be attached **once**, and only by the person who made it. An unknown, used or somebody else's `attachmentId` is the same 422 `ATTACHMENT_NOT_FOUND`. A file that nothing uses after 24 hours is an orphan and is cleaned up by the worker's `sweep-orphan-attachments` job, which runs every hour by default and removes the row and the file ([ADR 0010](adr/0010-job-design-and-cleanup.md)).
- Photos are resized to 1200 px JPEG by the web app before upload.

### Search

`GET /chats/:id/messages?q=` (Postgres full-text search over a chat's full history) is **not** built. In-chat search still runs on the messages already loaded in the browser. It is optional, and it needs a design for ranking, highlighting and paging that the web app does not have yet.

## Real-time (socket.io)

Every API instance runs the gateway; events reach a person on whichever instance holds their connection, through Redis ([ADR 0009](adr/0009-realtime-delivery-and-presence.md)).

### Connecting

Connect to `NEXT_PUBLIC_WS_URL` (default: the API origin) with `transports: ["websocket"]` and the access token in the handshake: `auth: { token }`. There is no long-polling, so no sticky sessions are needed behind a load balancer. A message is at most 16 KB.

A browser page must come from an origin in `CORS_ORIGINS` or from the API's own host. A client that sends no `Origin` (a phone app, a load test) is let through to the token check, because auth is by token and not by cookie.

The server checks the token in the handshake and puts the connection in the person's room (`user:{id}`) **before** it tells the client it is connected, so no event can be missed between `connect` and being subscribed. A refused handshake reaches the client as `connect_error`, with `error.data.code`:

| `data.code`     | Meaning                                                                                                                     |
| --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `UNAUTHORIZED`  | No token, a bad, forged or expired one (including one that has just expired), or the account no longer exists.              |
| `SHUTTING_DOWN` | This instance is draining. Try again: the load balancer will send the client to another one.                                |
| `SERVER_ERROR`  | The server could not check the token (for example Redis or the database is down). Try again with backoff.                   |

### Tokens and reconnecting

A connection is checked once, so it never outlives its token: **at the token's expiry the server closes the connection** (a transport close, not a clean disconnect). The client then reconnects by itself and presents `auth.token` again. If the client's token is still the old one, that handshake is refused with `UNAUTHORIZED`.

socket.io does not retry a refused handshake. On `connect_error` with `data.code === "UNAUTHORIZED"` the client must get a new access token (`POST /auth/refresh`), set it where `auth` reads it, and call `socket.connect()` again. If it cannot refresh, it stays out: a stale socket is never trusted. After any reconnect the client refetches chats, the open chat and contacts, because events sent while it was away are not kept.

The web app does all of this. Its socket asks the session manager for a token on `UNAUTHORIZED`, which shares one refresh with any REST call that failed at the same moment, and then connects again. After `SHUTTING_DOWN`, `SERVER_ERROR` or a close by the server it waits 1 s, doubling to 10 s, before it tries again. It renews the access token on its own 60 s before it expires, so the close at expiry is normally followed by a reconnect with a token that is already new. See [ADR 0011](adr/0011-session-handling-in-the-web-app.md).

On shutdown an instance first refuses new connections (`SHUTTING_DOWN`), then closes its own, so clients reconnect to another instance.

### Server to client

| Event             | Payload                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------- |
| `message:new`     | `{ message: MessageDto }` (also for the sender's own messages, so other devices update) |
| `message:updated` | `{ message: MessageDto }` (edit, delete, reaction)                                      |
| `chat:updated`    | `{ chat: ChatDto }`                                                                     |
| `chat:removed`    | `{ chatId }`                                                                            |
| `typing`          | `{ chatId, contactId, name, isTyping }`                                                 |
| `presence`        | `{ contactId, online }`                                                                 |
| `status:new`      | `{ status: StatusDto }`                                                                 |

Every payload is written for the person who gets it: `senderId`, `memberIds`, reaction lists, `contactId` and `ownerId` are **that person's** ids (their own id for themselves, their contact ids for everybody else), the same as in REST responses. Events are sent after the change is committed, and only for a new message (a replayed `clientId` sends nothing).

Who hears what:

| Cause                                                              | Who gets it                                                                                                                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A message is sent                                                  | `message:new` to every member who can see it, including the sender's other devices (it carries the sender's `clientId`). Each is followed by that person's `chat:updated`, with the message as `lastMessage`. |
| A message is sent to somebody who blocked the sender               | The sender only. The blocker gets nothing ([edge case 19](edge-cases.md)).                                                                                                                         |
| A message arrives in a chat the person had deleted                 | The chat comes back: `message:new` and `chat:updated`.                                                                                                                                            |
| Edit, delete for everyone, reaction                                | `message:updated` to every member who can see the message.                                                                                                                                        |
| Delete for me                                                      | `chat:updated` to that person only (the last message may have changed).                                                                                                                           |
| Forward                                                            | `message:new` and `chat:updated` in each target chat, to its members.                                                                                                                             |
| Pin, archive, mute, read, clear                                    | `chat:updated` to the person who did it (all their devices), nobody else.                                                                                                                         |
| Delete a chat                                                      | `chat:removed` to that person only. The other members keep it.                                                                                                                                    |
| Create a group, rename it, add members                             | The system note's `message:new` and `chat:updated` to every member, new ones included.                                                                                                            |
| Remove a member                                                    | `chat:removed` to the removed member, the system note and `chat:updated` to the rest.                                                                                                             |
| A status is posted                                                 | `status:new` to the author's devices (as seen) and to everybody who has the author as a contact, saved or not.                                                                                    |
| Somebody types                                                     | `typing` to the other members, see below.                                                                                                                                                         |
| Somebody's first connection opens, or their last one is gone       | `presence` to everybody who has them as a contact, see below.                                                                                                                                     |

**No event** is sent when a status is deleted, when a contact is blocked, renamed or deleted (a block does change presence, below), or when somebody changes their profile (name, about, photo). The contract has none for them. The other side sees the change on its next load ([edge case 71](edge-cases.md)).

Ordering: events about one chat from one instance are sent in the order the changes were committed. Two instances announcing the same chat at the same instant can interleave, so a client matches messages and chats by `id` (it does) and never relies on arrival order alone.

### Client to server

`typing` with `{ chatId, isTyping }`. The client sends it at most every 3 seconds while typing and once more with `false` when it stops.

- The server passes `true` on at most once a second per chat per connection. `false` always goes through.
- Only members of the chat can type into it, and it is heard only by the other members for whom the chat is on their list, who have a contact row for the typer. A new direct chat reaches the other person with its first message.
- Anything that is not `{ chatId: <uuid>, isTyping: <boolean> }` is dropped without an answer.
- If a connection drops while its person was typing, the others get `isTyping: false`.
- The `name` is the typer's first name from the listener's own address book.

### Presence

`presence` is sent when somebody's **first** connection opens (online) and when their **last** one has been gone for 5 seconds (offline), so a page reload announces nothing and a second device changes nothing. It goes to everybody who has them as a contact, with `contactId` being the listener's own contact for them. `GET /contacts` reports the same state in `online`. Shared bots keep their seeded `online`.

If either person has blocked the other, each sees the other as offline, in `GET /contacts` and in events, and typing between them is not sent. Blocking or unblocking sends both of them the contact's current state straight away. If a server instance crashes, its people are announced offline by another instance once their connection has gone 45 seconds without a heartbeat. These timings are the defaults of `PRESENCE_HEARTBEAT_MS`, `PRESENCE_SOCKET_TTL_MS` and `PRESENCE_OFFLINE_DEBOUNCE_MS`.

## Other notes for the backend

- **CORS**: allow the web app's origin, the `Authorization` header, and (for sockets) the same origin.
- **Token storage**: the access token stays in memory and is never written to storage. The refresh token lives in the `httpOnly` cookie `dt_refresh`, and the web app sends `credentials: "include"` on every `/auth/*` call. On a page load the app has no token, so it calls `POST /auth/refresh` first. In mock mode a saved flag plays the cookie's part.
- **Cookie behind the web app's proxy**: the web app serves the API under its own `/api` path (a Next rewrite to `API_PROXY_TARGET`), which keeps the cookie first-party. Then the API must run with `COOKIE_PATH=/api/auth`, so the browser sends the cookie to `/api/auth/refresh`, and `TRUST_PROXY=1`, so rate limits see the visitor and not the web server. The socket does not go through the proxy: it connects straight to the API with the access token (`NEXT_PUBLIC_WS_URL`), and the web origin must be in `CORS_ORIGINS`. A request body through the proxy is capped by Next at 10 MiB ([edge case 95](edge-cases.md)).
- **In-chat search** runs on the messages already loaded in the browser. See [Search](#search).
- The chat list search matches the chat title and the latest message only.
- Unread counts are server state: `POST /chats/:id/read` resets them and the server emits `chat:updated` to that person's devices.
