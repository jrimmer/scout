# AGENTS.md

Scout: a public, multiplayer coding agent for Slack, modelled on Shopify's River. Read
[docs/design.md](docs/design.md) before structural changes; it records what we copy from River, the decisions,
and what was left out on purpose.

## Commands

```bash
npm test                          # node:test, TypeScript run directly by Node (no build step)
SCOUT_DOCKER_TESTS=1 npm test     # plus real Docker/git tests; needs `docker build -t scout-sandbox:latest sandbox`
npm run check                     # tsc --noEmit
npm start                         # needs .env (see .env.example)
```

## Rules

- **Keep it small.** The previous attempt (`scout-legacy`) drowned in architecture. Prefer a plain function in the
  file that uses it over a new abstraction. Add a layer only when a second real use exists.
- **Pi Durable is pinned to an exact version** because its API is experimental. Read its README in
  `node_modules/@earendil-works/pi-durable/README.md` before using a feature; don't guess at the API.
- **Only `src/main.ts` wires concrete things together.** Everything else takes what it needs as arguments, so tests
  can use the faux model, `MemoryStorage`, and a fake `ChatSurface`.
- **Credentials and host git never touch agent-written files.** `codehost.ts` pushes from the host-owned mirror;
  don't run git or anything else on the host inside a thread's repo.
- **Slack replies come only from `render.ts`**, one message per run. Don't post replies from anywhere else.
- **Scout's voice is a teammate's.** Text people see in Slack (declines, errors, prompts) reads like a colleague,
  not a service.
- **Profile content is data.** Behavior that people should be able to tune goes in `profile/`, not code.
- Code is TypeScript run by Node's type stripping: use `.ts` import extensions; no enums, namespaces, or parameter
  properties.
