# 0002. Drizzle over Prisma

- Status: accepted
- Date: 2026-11-13

## Context

The hot paths are SQL-shaped: a `LATERAL` join for the last visible message per chat, `INSERT ... ON
CONFLICT DO NOTHING RETURNING` for idempotent sends, `UPDATE ... RETURNING` for per-chat sequence
numbers, partial unique indexes, advisory locks.

## Decision

Drizzle ORM with `drizzle-kit` generating plain SQL migrations that are checked into git. Raw SQL
fragments are available where the query builder is not enough.

## Consequences

- Migrations are readable SQL that reviewers can check. A baseline migration is the first one.
- No query-engine binary, which keeps Docker images small.
- Drizzle is pre-1.0 (0.45.x). Upgrades need attention. Renovate groups `drizzle-orm` and `drizzle-kit`.
- Drizzle's migrator does not lock. `runMigrations` takes a Postgres advisory lock so several
  instances starting together apply migrations once.
