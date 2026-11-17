Labels: help wanted
# Read receipts

The app counts unread messages per person but never tells the sender that anyone has read anything.

**Idea.** Record, per chat member, the last `seq` they have read (the unread counter already resets on
`POST /chats/:id/read`), and show "read" ticks to the sender for direct chats and a count for groups. It needs a
contract change (a field on the message or an event) and a decision about a per-person privacy setting.

**Start here.** `packages/db/src/schema/chats.ts` (`chat_members`), `packages/core/src/conversations/chats.service.ts`.

**Done when.** Both sides see the receipt update live over the socket, and blocking and the privacy setting are
respected.
