Labels: help wanted
# Search a chat's full history (`GET /chats/:id/messages?q=`)

In-chat search only looks at the messages already loaded in the browser. The API has no `q` parameter.

**Idea.** Postgres full-text search (`to_tsvector`, a GIN index) over message text, scoped to one chat and
respecting what the viewer cleared or hid. It needs a design for ranking, highlighting and paging: a result is not
a place in the chat's order, so the cursor from [ADR 0015](../../docs/adr/0015-cursor-paging-over-offset.md) does not apply
as it is. Then wire the web app's search box to it.

**Start here.** `packages/core/src/conversations/messages.service.ts` (`page`), `docs/API.md` (Search).

**Done when.** The endpoint is documented in OpenAPI, tested for access (404 for a chat that is not yours) and for
hidden and cleared messages, and the conformance suite has a test for it.
