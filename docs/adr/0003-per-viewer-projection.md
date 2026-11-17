# 0003. Per-viewer projection

- Status: accepted. Implemented for contacts, chats and message history (`Projector`, the viewer directory and structured system messages). Realtime fan-out per member is in [ADR 0009](0009-realtime-delivery-and-presence.md).
- Date: 2026-11-13

## Context

The API contract is written from one viewer's point of view. `senderId` is either `MeDto.id` or a
contact id, and `ChatDto.memberIds` are contact ids. With real users, every viewer has a different
contact row, and so a different id, for the same person.

## Decision

A single `Projector` in `core` turns database rows into DTOs for a given viewer. It maps user ids to the
viewer's contact ids (the viewer keeps their own user id, `system` stays `system`) in `senderId`,
reaction lists, reply previews, `memberIds`, typing and presence. Realtime never broadcasts one payload
to a chat room: each member gets their own projection in the room `user:{id}`.

Related decisions:

- Contact maps are loaded once per request or send in one query. Projection itself is a pure function.
- System messages ("You created this group") are stored as structured events (kind, actor, targets,
  name) and rendered per viewer at projection time, because the text differs for each member
  ("You added Priya" for the actor, "Alex added you" for the target).
- Reply previews are joined at projection time, never copied, so edits and deletions show up.
- A contact row can be "unsaved": it exists only to render a sender and is not part of the address book
  unless the person saved it.

## As built

- `Projector` is a pure function over a viewer directory: one query maps every user id the viewer can see to their contact id. The three id spaces (the viewer's own user id, contact ids, `"system"`) have unit tests.
- Contacts are created on demand with `ensureContacts`, so every member of a chat has a contact row for every other member. Unsaved rows exist only to render a sender.
- `GET /chats` loads memberships with the last visible message (a `LATERAL` join), the other members and the directory in three queries however many chats there are.
- A group's creator, its members and a direct chat's two people each see their own `memberIds` and their own system-note wording.

## Consequences

More moving parts than a shared payload, but one tested place for the id mapping. Fan-out cost grows
with group size, which [docs/scaling.md](../scaling.md) measures.
