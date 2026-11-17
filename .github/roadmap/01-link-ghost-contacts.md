Labels: help wanted
# Link a ghost contact to a user who registers later

`POST /contacts` with a phone number links the contact to a registered user if there is one. If there is none, it
creates a private "ghost" bot user so the app still behaves like the prototype (add a contact, get an
auto-reply). A real person who registers later with that number is **not** linked to the ghost, so the owner keeps
chatting with a bot.

**Idea.** When an account is created with a phone number, find the ghosts that were made for that number, re-point
those contacts at the new user, and move the direct chats over (or create fresh ones and keep the history
readable). Decide what happens to the old bot messages.

**Start here.** `packages/core/src/conversations/contacts.service.ts`, `docs/edge-cases.md` (items 1 to 3 and 38 to 40).

**Done when.** A test registers a user after someone added their number and shows the contact now belongs to the
real user, with the chat history intact and no duplicate direct chat.
