Labels: help wanted
# Web push notifications

A person who is not in the tab gets no notice of a new message.

**Idea.** A service worker and the Web Push protocol (VAPID). Store a subscription per device, and have the worker
send a push when a message is delivered to someone with no connected socket (presence is already in Redis).
Respect muted chats and blocked contacts.

**Start here.** `packages/core/src/realtime/presence.service.ts`, the bot-reply job in `apps/worker` as an example
of a job that runs after a send.

**Done when.** A person with the tab closed gets a notification, a muted chat sends none, and the job is idempotent
(it is at-least-once).
