Labels: good first issue
# End every tab's session at once when one tab signs out

Signing out revokes the session on the server, but other open tabs keep working until their access token expires
(at most 15 minutes) and only then notice ([edge case 98](../../docs/edge-cases.md)).

**Idea.** Broadcast the sign-out between tabs of the same browser (`BroadcastChannel`, with a `storage` event
fallback) so every tab clears its in-memory token and shows the login page straight away.

**Start here.** `apps/web/src/lib/auth/session-manager.ts` and its tests.

**Done when.** A unit test shows a second session manager reacting to the first one's sign-out, and an e2e test
signs out in one browser tab and sees the other return to the login page.
