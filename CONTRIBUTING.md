# Contributing

```bash
npm ci
npm test            # node:test, TypeScript run directly by Node (no build step)
npm run check       # tsc --noEmit
SCOUT_DOCKER_TESTS=1 npm test   # plus real Docker and git tests; needs `docker build -t scout-sandbox:latest sandbox`
```

Read [AGENTS.md](AGENTS.md) first: it holds the rules the codebase keeps (small over clever, one place that wires
things together, replies only from `render.ts`, Scout's voice, profile content as data). [docs/design.md](docs/design.md)
says what Scout copies from River, what it decided, and what it left out on purpose.

- Keep `main` building: CI runs the type check, the tests, and the Docker tests on your pull request merged with the
  latest `main`, and again on `main` after it lands (`.forgejo/workflows/ci.yml`). Nothing blocks a merge on it, so look.
- One change per pull request, with tests for the behaviour it changes. Tests use the faux model, `MemoryStorage`
  and a fake `ChatSurface`; a scripted tool call needs `{ stopReason: "toolUse" }`.
- End-to-end tests start Scout's real service (`startScout` in test/e2e.ts) in front of fake Slack, a fake code host
  and, where needed, fake Gatus and Grafana (test/fake-*.ts); timers are off, so a test runs housekeeping, alerts or CI
  with `service.tick`. Wait with `until` (test/helpers.ts), never a fixed sleep: to show something didn't happen,
  wait for the work to be over (an awaited tick, `waitForIdle`), then look.
- Update `docs/operations.md` (and `.env.example`, for a new setting) in the same pull request.
- Behaviour people should be able to tune belongs in the profile, not in code.
- Text people see in Slack or on the code host reads like a colleague wrote it, not a service.
- Pi Durable is pinned to an exact version; read its README before using a feature.
