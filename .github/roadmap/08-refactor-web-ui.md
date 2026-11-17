Labels: good first issue
# Turn the web app's lint rules back on

`apps/web` reports 12 Biome warnings (cognitive complexity, hook dependencies) and has a list of rules switched off in
`biome.jsonc`, because the UI was written as a prototype ([ADR 0008](../../docs/adr/0008-biome-over-eslint-prettier.md)).

**Idea.** Pick one component, such as `ConversationBody` (complexity 42), split it into smaller pieces or hooks, fix
its effect dependencies, and remove the matching opt-out. One component per pull request.

**Start here.** `pnpm lint` shows the list. `apps/web/src/components/conversation.tsx` is the biggest.

**Done when.** The warning for that component is gone, the unit and Playwright tests pass, and behaviour is unchanged.
