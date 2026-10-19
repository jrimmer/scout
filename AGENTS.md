# AGENTS.md

Scout: a public, multiplayer coding agent for Slack, modelled on Shopify's River. Read
[docs/design.md](docs/design.md) before structural changes; it records what we copy from River, the decisions,
and what was left out on purpose.

## Commands

```bash
npm test                          # node:test, TypeScript run directly by Node (no build step)
SCOUT_DOCKER_TESTS=1 npm test     # plus real Docker/git tests; needs `docker build -t scout-sandbox:latest sandbox`
npm run check                     # tsc --noEmit
npm start                         # the Slack service; needs .env (see .env.example)
npm run job -- "what to do"       # one task with the same agent, no Slack
```

## Rules

- **Keep it small.** The previous attempt (`scout-legacy`) drowned in architecture. Prefer a plain function in the
  file that uses it over a new abstraction. Add a layer only when a second real use exists.
- **Pi Durable is pinned to an exact version** because its API is experimental. Read its README in
  `node_modules/@earendil-works/pi-durable/README.md` before using a feature; don't guess at the API.
- **Only `src/scout.ts` wires concrete things together** (with `main.ts` and `job.ts` as front doors). Everything
  else takes what it needs as arguments, so tests can use the faux model, `MemoryStorage`, and a fake `ChatSurface`.
  `openScout` takes `models` for the same reason.
- **In tests, a scripted tool call needs `{ stopReason: "toolUse" }`**, or the harness takes it as a final answer
  and runs nothing.
- **Credentials and host git never touch agent-written files.** `codehost.ts` pushes from the host-owned mirror;
  don't run git or anything else on the host inside a thread's repo. Tools that need credentials (pull requests,
  MCP) run on the host; the sandbox gets none.
- **Slack replies come only from `render.ts`**, one message per run. Don't post replies from anywhere else.
- **Scout's voice is a teammate's.** Text people see in Slack (declines, errors, prompts) reads like a colleague,
  not a service.
- **Profile content is data.** Behavior that people should be able to tune goes in `profile/`, not code.
- Code is TypeScript run by Node's type stripping: use `.ts` import extensions; no enums, namespaces, or parameter
  properties.
