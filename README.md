# Scout

A coding teammate that lives in Slack and works only in public. Mention `@Scout` in a public channel and it reads
the code, runs tests, makes the change, and opens a pull request, in a thread anyone can follow, join, redirect, and
learn from. Modelled on Shopify's River; see [docs/design.md](docs/design.md).

- **Multiplayer threads.** One Slack thread is one durable conversation
  ([Pi Durable](https://earendil.com/posts/pi-durable/)).
  - It survives restarts.
  - Anyone in the thread can redirect the work.
  - A stop sign (or "@Scout stop") stops it.
  - A change made through a tool that needs approval waits for "approve", or a 👍 on Scout's request.
  - 🔁 on its answer tries again; editing a request steers the work.
  - Nothing said while Scout restarts is lost, and its progress message says what it's waiting on.
  - "Ask Scout about this" on any message, or 🔍, starts a thread there; `/scout` and its Home tab show what it's
    doing and what's waiting on you.
  - A request's reaction follows the work (🧠 thinking, 📖 reading, 🧪 testing…), ending ✅, ⚠️ or 🙋; changes
    waiting for approval get Approve and Decline buttons.
  - Each channel gets a canvas of what's open; a Slack List tracks all of Scout's work; links to the code host
    preview with their state; Workflow Builder gets an Ask Scout step.
- **All your code.** Any thread can search and read every repository Scout works in, not just its own checkout.
- **Its own sandbox.** Each thread gets its own clone, in its channel's repository, and its own Docker container.
  Credentials never enter it.
- **Reviewed before you review it.** Scout reviews its own diff before opening a pull request, and keeps pull
  requests small.
- **It learns.** What Scout knows lives in `profile/` as files: a system prompt, skills, and per-channel
  instructions, repositories and zones.
  - Scout keeps notes as it works.
  - Every night it reads its threads and opens a pull request against its profile with what it learned. Merge it,
    and every thread gets it.
  - Every Monday it reports its merge rate, and posts each channel's week: what it did there, what's still open,
    and what it noted.
- **As proactive as you want.** `SCOUT_INITIATIVE` is one dial: `asked` (only what people ask), `own` (also looks
  after its own work), or `team` (also acts on the team's work: alerts, reminders, summaries). Scout says which, and
  what it means, when it starts.
- **Several approaches at once** (experimental). Ask Scout to try a few ways and it works on them side by side,
  then lets you pick one from a comparison in the thread.
- **A tidy colleague.** It asks the code's owners to review its pull requests, keeps them mergeable when the base
  moves (or says why it can't), asks about ones that have gone quiet before closing them, deletes its branches once
  they're merged, and reminds reviewers of anyone's pull requests that have waited on them for days.
- **Beyond code.** MCP servers (the data warehouse, traces, CI) run on the host, optionally per channel.
- **A dashboard** (after spoond's): what Scout is working on, its merge rate, what it's learning, the notes nobody
  has reviewed yet, and what it costs, live, at `http://127.0.0.1:8893/`.
- **Five ways in:**
  - Slack threads.
  - The code host (Forgejo or GitHub): assign Scout an issue, or mention `@scout` in an issue, a pull request or a
    comment. It works in a thread in the repository's channel and answers on the issue too (in full only where the
    repository is private). Comments on its own pull
    requests go back to the thread that opened them.
  - Pull requests that ask Scout for a review: it reviews like a colleague, and says so in the repository's channel.
  - Schedules: "every Monday at 9, check for dependency updates". Each run is a new thread in the channel, and
    anyone there can list, change, pause or remove the channel's schedules by asking.
  - `npm run job -- "…"` for one-off work.
- **`npm run doctor`** (or `/scout doctor`) checks every integration and says how to fix what's wrong.

## Run it

Setting it up from scratch: [docs/setup.md](docs/setup.md). The security model: [docs/security.md](docs/security.md).


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
gateway, backups with Litestream, secrets from files or 1Password, telemetry, who may ask for work, budgets,
capacity (how many runs and model calls at once, and what Scout tells people while they wait), the audit trail and
retention.

For the learning loop, put `profile/` in its own repository and set `SCOUT_PROFILE_REPO_URL`. Everything else
optional is in `.env.example`.

## Develop

```bash
npm test                                   # unit and end-to-end tests with a scripted model
SCOUT_DOCKER_TESTS=1 npm test              # also the real container, clone, and push
npm run check                              # type-check
npm run job -- "what to do"                # one task, no Slack
```

## License

BSD 3-Clause; see [LICENSE](LICENSE).
