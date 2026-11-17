# Architecture

Four diagrams, each answering one question: what are the parts, what is stored, what happens when one
message is sent, and where does it all run. They are Mermaid, which GitHub renders in the page. The
decisions behind them are in the [ADRs](adr/README.md).

## 1. The parts

Two deployables, `apps/api` and `apps/worker`, share domain code through `packages/`. Every business rule
has one implementation in `packages/core`, and both apps call it. The API and the worker never import each
other (`pnpm lint:boundaries` fails the build if they do). See
[ADR 0001](adr/0001-two-deployables-shared-libraries.md).

```mermaid
flowchart LR
  subgraph Clients
    Web[Next.js web app]
  end
  Web -->|HTTPS REST| LB[nginx / platform LB]
  Web -->|WebSocket| LB
  LB --> API1[NestJS API #1]
  LB --> API2[NestJS API #2]
  LB --> API3[NestJS API #3]
  API1 & API2 & API3 --> PG[(PostgreSQL)]
  API1 & API2 & API3 <-->|socket.io adapter, presence, throttling| REDIS[(Redis)]
  API1 & API2 & API3 --> S3[(S3-compatible storage)]
  API1 & API2 & API3 -->|enqueue jobs| REDIS
  REDIS -->|jobs| WORKER[apps/worker: bot replies, cleanup jobs]
  WORKER -->|socket events via Redis emitter| REDIS
  WORKER --> PG
  WORKER --> S3
  API1 & API2 & API3 & WORKER -.->|OTLP| OTEL[OTel Collector]
  OTEL --> TEMPO[Tempo]
  OTEL --> PROM[Prometheus]
  OTEL --> LOKI[Loki]
  TEMPO & PROM & LOKI --> GRAF[Grafana]
```

What holds state: PostgreSQL (everything durable), Redis (socket.io rooms, presence, throttling counters,
job queues) and the S3-compatible store (file bytes). The API and worker processes hold none that matters,
which is why any number of them can run. [docs/scaling.md](scaling.md) has the measurements.

Package dependencies point one way:

```mermaid
flowchart TD
  web[apps/web] -.->|types only| contracts
  api[apps/api] --> core
  worker[apps/worker] --> core
  api --> telemetry
  worker --> telemetry
  core --> db
  core --> contracts
  core --> telemetry
  db --> contracts
  loadtest[ops/loadtest] -.->|types only| contracts
```

## 2. What is stored

Generated from the newest Drizzle snapshot (`packages/db/drizzle/meta`) by
`node ops/scripts/gen-er-diagram.mjs`, and checked in CI (`--check`), so it cannot drift from the schema.
Ids are UUIDv7, so they sort by creation time. `messages.seq` is the message's place in its chat and is
what history paging is built on ([ADR 0015](adr/0015-cursor-paging-over-offset.md)).

<!-- er-diagram:start -->
```mermaid
erDiagram
  attachments {
    uuid id PK
    uuid owner_id FK
    text storage_key
    text name
    integer size
    text mime
    integer width "nullable"
    integer height "nullable"
    timestamptz created_at
  }
  chat_members {
    uuid chat_id PK, FK
    uuid user_id PK, FK
    integer unread_count
    boolean archived
    boolean pinned
    boolean muted
    bigint cleared_before_seq
    timestamptz hidden_at "nullable"
    timestamptz joined_at
    timestamptz left_at "nullable"
  }
  chats {
    uuid id PK
    text type
    text name "nullable"
    smallint hue "nullable"
    text direct_key "nullable"
    uuid created_by FK "nullable"
    bigint last_seq
    timestamptz created_at
  }
  contacts {
    uuid id PK
    uuid owner_id FK
    uuid linked_user_id FK
    text name
    text phone "nullable"
    text phone_digits "nullable"
    text about "nullable"
    smallint hue "nullable"
    text avatar_url "nullable"
    boolean blocked
    boolean saved
    timestamptz created_at
  }
  message_hidden {
    uuid user_id PK, FK
    uuid message_id PK, FK
    timestamptz created_at
  }
  message_reactions {
    uuid message_id PK, FK
    uuid user_id PK, FK
    text emoji
    timestamptz created_at
  }
  messages {
    uuid id PK
    uuid chat_id FK
    bigint seq
    uuid sender_id FK "nullable"
    text client_id "nullable"
    text kind
    text text "nullable"
    integer duration "nullable"
    jsonb bars "nullable"
    uuid attachment_id FK "nullable"
    uuid reply_to_id FK "nullable"
    boolean forwarded
    boolean edited
    boolean deleted
    jsonb event "nullable"
    timestamptz created_at
  }
  refresh_tokens {
    uuid id PK
    uuid user_id FK
    uuid family_id
    text token_hash
    timestamptz expires_at
    timestamptz rotated_at "nullable"
    timestamptz revoked_at "nullable"
    timestamptz created_at
    text user_agent "nullable"
  }
  status_views {
    uuid status_id PK, FK
    uuid viewer_id PK, FK
    timestamptz viewed_at
  }
  statuses {
    uuid id PK
    uuid owner_id FK
    uuid audience_id FK "nullable"
    text text
    smallint color
    timestamptz created_at
    timestamptz expires_at
  }
  users {
    uuid id PK
    text email "nullable"
    text password_hash "nullable"
    text name
    text about
    uuid avatar_attachment_id FK "nullable"
    smallint hue
    text phone "nullable"
    text phone_digits "nullable"
    jsonb preferences
    boolean is_bot
    boolean bot_online_default
    boolean is_guest
    timestamptz guest_expires_at "nullable"
    uuid ghost_owner_id FK "nullable"
    timestamptz created_at
  }
  users ||--o{ attachments : "owner_id"
  chats ||--o{ chat_members : "chat_id"
  users ||--o{ chat_members : "user_id"
  users |o--o{ chats : "created_by"
  users ||--o{ contacts : "owner_id"
  users ||--o{ contacts : "linked_user_id"
  users ||--o{ message_hidden : "user_id"
  messages ||--o{ message_hidden : "message_id"
  messages ||--o{ message_reactions : "message_id"
  users ||--o{ message_reactions : "user_id"
  chats ||--o{ messages : "chat_id"
  users |o--o{ messages : "sender_id"
  attachments |o--o{ messages : "attachment_id"
  messages |o--o{ messages : "reply_to_id"
  users ||--o{ refresh_tokens : "user_id"
  statuses ||--o{ status_views : "status_id"
  users ||--o{ status_views : "viewer_id"
  users ||--o{ statuses : "owner_id"
  users |o--o{ statuses : "audience_id"
  attachments |o--o{ users : "avatar_attachment_id"
  users |o--o{ users : "ghost_owner_id"
```
<!-- er-diagram:end -->

Three things the diagram does not say:

- `contacts` is each person's own address book. The same person has a different contact id for every viewer,
  which is why one `Projector` turns user ids into the viewer's ids on the way out
  ([ADR 0003](adr/0003-per-viewer-projection.md)).
- `chat_members` holds per-person chat state (unread count, pinned, archived, muted, what was cleared). The
  unread count is a counter written in the send transaction, never a `COUNT(*)`.
- `message_hidden` is both "delete for me" and how a message to someone who blocked you is kept from them
  for good ([ADR 0017](adr/0017-blocking-semantics.md)).

## 3. One message, from the browser to the other browser

`POST /chats/:id/messages` with a client-made `clientId`. The sender's response does not wait for the
fan-out: after the commit the API instance queues the announcement to the chat's members (each instance keeps a
chat's announcements in order, and there is no ordering lock across instances,
[ADR 0009](adr/0009-realtime-delivery-and-presence.md)), and, if the other person is a bot, schedules the bot's
reply as delayed jobs.

```mermaid
sequenceDiagram
  autonumber
  participant A as Browser A (sender)
  participant API1 as API instance 1
  participant PG as PostgreSQL
  participant R as Redis
  participant API2 as API instance 2
  participant B as Browser B (recipient)
  participant W as Worker

  A->>API1: POST /chats/:id/messages {clientId, text}
  API1->>PG: BEGIN, lock the chat row
  API1->>PG: look up (chat, sender, clientId)
  alt clientId already stored (a retry)
    PG-->>API1: the original message
    API1-->>A: 200 original message, nothing else happens
  else new message
    API1->>PG: check blocks, content, attachment, reply target
    API1->>PG: last_seq + 1, INSERT message with that seq
    API1->>PG: unread_count + 1 for the other members
    API1->>PG: COMMIT
    API1-->>A: 201 message (projected for A)
    par after the commit, off the response path
      API1->>R: emit message:new to room user:{id}, once per member, each in that member's projection
      R-->>API2: socket.io adapter delivers to the instance holding B's socket
      API2-->>B: message:new
    and
      API1->>R: add delayed jobs bot-typing and bot-reply (only if a bot is the other member)
    end
  end
  opt a bot is the other member
    R-->>W: bot-typing job, after about 0.7 s
    W->>R: emit typing true to A
    R-->>W: bot-reply job, after about 2.4 s
    W->>PG: MessagesService.send(...) with clientId bot-reply:{messageId}, the same path as above
    W->>R: emit message:new to A, emit typing false
  end
```

A replay (step 4, the `alt` branch) adds no message, no unread count and no event. Five concurrent sends of the
same `clientId` produce one message, because the chat row lock orders them and the unique index on
`(chat_id, sender_id, client_id)` backs that up ([ADR 0014](adr/0014-idempotency-keys-for-sends.md)).
The worker sends the bot's reply through the same `MessagesService.send`, so a retried job is also a replay.

## 4. Where it runs

### Docker Compose (what the repository runs today)

One Compose file, three modes. The default profile-less `docker compose up -d` starts only the services
(Postgres, Redis, S3-compatible storage) for development on your machine.

```mermaid
flowchart TB
  subgraph app["--profile app"]
    migrate[migrate, then seed] --> api[api :3001]
    web[web :3000] --> api
    worker[worker :3002 health]
  end
  subgraph scale["--profile scale"]
    lb[nginx :8080, least_conn, no sticky sessions] --> sapi1[scale-api x3]
    sworker[scale-worker x2]
  end
  subgraph obs["--profile observability"]
    otel[OTel Collector] --> tempo[Tempo]
    otel --> prom[Prometheus]
    otel --> loki[Loki]
    tempo & prom & loki --> grafana[Grafana :3030]
  end
  subgraph base["always on"]
    pg[(Postgres)]
    redis[(Redis, noeviction)]
    s3[(SeaweedFS S3)]
  end
  api & worker & sapi1 & sworker --> pg & redis & s3
  api & worker & sapi1 & sworker -.->|only when OTEL_EXPORTER_OTLP_ENDPOINT is set| otel
```

### Hosted demo (planned, not provisioned)

This is the planned shape. Nothing here exists yet, and hosts, plans and prices have to be checked
when the demo is deployed. It is drawn so the production configuration (cookies, `TRUST_PROXY`, CORS, rewrites) has
one picture to refer to.

```mermaid
flowchart LR
  Browser --> Vercel[Web on Vercel]
  Vercel -->|"/api/* rewrite, so the cookie is first party"| API[API service, always on]
  Browser -->|WebSocket, access token in the handshake| API
  API & Worker[Worker service, always on] --> Neon[(Postgres)]
  API & Worker --> Redis[(Redis)]
  API & Worker --> R2[(Object storage)]
  API & Worker -.->|OTLP| GC[Grafana Cloud]
```
