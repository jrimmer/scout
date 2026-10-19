# Scout

A coding teammate that lives in Slack and works only in public. Mention `@Scout` in a public channel and it reads
the code, runs tests, makes the change, and opens a pull request, in a thread anyone can follow, join, redirect, and
learn from. Modelled on Shopify's River; see [docs/design.md](docs/design.md).

- **Multiplayer threads.** One Slack thread is one durable conversation
  ([Pi Durable](https://earendil.com/posts/pi-durable/)).
  - It survives restarts.
  - Anyone in the thread can redirect the work.
  - A stop sign (or "@Scout stop") stops it.
- **Its own sandbox.** Each thread gets its own clone, in its channel's repository, and its own Docker container.
  Credentials never enter it.
- **Reviewed before you review it.** Scout reviews its own diff before opening a pull request, and keeps pull
  requests small.
- **It learns.** What Scout knows lives in `profile/` as files: a system prompt, skills, and per-channel
  instructions, repositories and zones.
  - Scout keeps notes as it works.
  - Every night it reads its threads and opens a pull request against its profile with what it learned. Merge it,
    and every thread gets it.
  - Every Monday it reports its merge rate.
- **Beyond code.** MCP servers (the data warehouse, traces, CI) run on the host, optionally per channel.
- **A dashboard** (after spoond's): what Scout is working on, its merge rate, what it's learning, the notes nobody
  has reviewed yet, and what it costs, live, at `http://127.0.0.1:8893/`.
- **Three ways in:**
  - Slack threads.
  - Pull requests labelled for review (it comments).
  - `npm run job -- "…"` for one-off work.

## Run it

Needs Node 24+, Docker, and git with access to your repositories. Give Scout its own code host account, token and SSH
key, so its work is its own.

```bash
npm install
docker build -t scout-sandbox:latest sandbox    # add your repos' toolchains to sandbox/Dockerfile first
cp .env.example .env                             # fill it in; create the Slack app from slack-manifest.yaml
npm start
```

Invite Scout to a public channel and mention it. Data (transcripts, notes, the thread map, the audit trail) lives in
`data/`. [docs/operations.md](docs/operations.md) covers the rest: sandboxes on Docker or spoond microVMs, a model
gateway, backups with Litestream, secrets from files or 1Password, telemetry, who may ask for work, budgets, the
audit trail and retention.

For the learning loop, put `profile/` in its own repository and set `SCOUT_PROFILE_REPO_URL`. Everything else
optional is in `.env.example`.

## Develop

```bash
npm test                                   # unit and end-to-end tests with a scripted model
SCOUT_DOCKER_TESTS=1 npm test              # also the real container, clone, and push
npm run check                              # type-check
npm run job -- "what to do"                # one task, no Slack
```
