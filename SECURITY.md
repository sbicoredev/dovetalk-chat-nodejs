# Security policy

## Supported versions

The latest release, `1.x`, receives security fixes. Older versions do not.

## Reporting a vulnerability

Please do **not** open a public issue. Use GitHub's private reporting:
**Security > Report a vulnerability** on the repository (`https://github.com/OWNER/dovetalk/security/advisories/new`).

Include what you found, how to reproduce it, and what it lets someone do. You can expect an answer within a few
days. This is a small project maintained in spare time, so there is no bounty and no guaranteed fix date, but a
real problem will be fixed and the reporter credited if they wish.

## What is in scope

The API, the worker, the web app and the Compose files in this repository.

## What the project already does

So you do not have to rediscover it:

- Passwords are hashed with Argon2id. Sign-in and guest creation are rate limited per IP, and sign-in per email, in
  Redis (so the limit holds across instances).
- Access tokens are short-lived JWTs held in memory. Refresh tokens are opaque, stored as a SHA-256 hash, rotated on
  every use, kept in an `httpOnly` cookie, and the whole family is revoked when a retired token is replayed outside a
  10-second window ([ADR 0016](docs/adr/0016-refresh-token-rotation.md)).
- Cookie-authenticated routes check `Origin` in addition to `SameSite`. Sockets refuse a browser page whose origin is
  not allowed, and authenticate by token in the handshake.
- Another person's chat, message, contact or status answers `404`, never `403`, so existence is not revealed.
- Uploads are limited to 10 MB, their type is read from the bytes, and downloads use short-lived signed URLs.
- Request bodies are validated, and a NUL character in any JSON body is rejected.

## Known limitations (not vulnerabilities)

These are documented decisions for a demo application. Reports about them will be answered with a link here.

- A phone number is **unverified**: anyone can claim a number first. There is no email verification and no password
  reset.
- The 10-second refresh reuse window means a token copied and replayed within 10 seconds of the owner's refresh is not
  detected ([ADR 0016](docs/adr/0016-refresh-token-rotation.md)).
- Messages are not end-to-end encrypted. They are readable by whoever runs the database.
- The Compose files and `.env.example` use development credentials. Do not expose that stack to the internet as it is.
