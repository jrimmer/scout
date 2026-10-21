# Running Scout

Everything here is optional beyond the basics in the README; `.env.example` lists every setting.

## Sandboxes

Each thread works in its own sandbox. `SCOUT_SANDBOX_DRIVER` picks where:

| Driver | What it is | Isolation |
|---|---|---|
| `docker` (default) | A container per thread on this host; work in a named volume | No capabilities, no new privileges, a non-root user, no host mounts but the read-only daemon |
| `spoond` | A Firecracker microVM per thread, leased from spoond | A VM. Persistent: idle threads suspend, checkpoints survive the host |
| `local` | A directory on this host | None. For tests and laptops only |

In all three, Scout runs a pi-env daemon inside the sandbox and does every file operation and command through it, so
nothing a thread writes reaches Scout's host. Git moves in and out as bundles, so no sandbox holds credentials.

**Network.** `SCOUT_SANDBOX_NETWORK` is `none` (default) or `open`. A repository can instead list the hosts its
sandboxes may reach (`egress` in `SCOUT_REPOS_FILE`, or `SCOUT_REPO_EGRESS` for the default repository). Only
substrates with an egress firewall can enforce a list: spoond can (its `restricted` policy and allowlist), Docker
can't, and Scout falls back to the default network there and says so.

**spoond.** Set `SCOUT_SPOOND_URL` and `SCOUT_SPOOND_TOKEN`. A repository whose toolchain isn't in a spoond image can
start from a named snapshot instead (`snapshot` in `SCOUT_REPOS_FILE`, or `SCOUT_REPO_SNAPSHOT`): save a lease with the
toolchain installed and its package cache warm, under Scout's spoond identity. The image (`SCOUT_SANDBOX_IMAGE`, default `dev-base`)
needs git; `SCOUT_SANDBOX_SIZE` is a spoond size class. Scout reaches each lease's daemon over spoond's stream
WebSocket and keeps that connection only while tools run (it closes after two idle minutes). spoond limits each
account's concurrent execs and streams together (`EXEC_CONCURRENCY_MAX`, 8 by default), so that limit bounds how many
threads can be *working* at once. Ask a spoond admin to raise it for Scout's account: about one per concurrent working
thread, plus a few for short commands. (`POST /api/users/{id}/quota` with `{"exec_concurrency": N}`, from the spoond
release after `c95af19`.) Then set Scout's concurrency limits (below) under it.

`SCOUT_SPOOND_TRANSPORT=rest` (spoond 3.11 and later) reaches leases through spoond's REST API instead: commands
run as background jobs that Scout follows with long polls and reads by offset, file contents go through the files API,
and the rest (renames, listings) runs as short commands in the lease. Scout then holds no connection at all, so only
commands running at that moment count against the account's limit, and nothing is lost when Scout restarts mid-command
(the command finishes in the lease). Output arrives a second or so later than over the stream, and file watching isn't
available (Scout's tools don't use it).

When spoond is nearly full it answers new leases with "wait" or "full", and Scout retries for up to ten minutes
before the thread hears that no sandbox was free. spoond also pauses leases to keep memory free; a paused lease
resumes on its next use, so a thread's first command after a quiet spell can take longer.

## Model gateway

`SCOUT_GATEWAY_URL` sends model calls to a gateway (Bifrost, LiteLLM, Cloudflare AI Gateway) instead of the provider,
with `SCOUT_GATEWAY_KEY` and any `SCOUT_GATEWAY_HEADERS` (JSON) on every request. Model names don't change. A model only
the gateway knows is `gateway/<its name>` (`SCOUT_MODEL=gateway/lunaroute/deepseek-4.1-flash`), spoken to with
OpenAI's chat completions API at `SCOUT_GATEWAY_URL` (the gateway's OpenAI base, e.g. `https://llm.lacy.casa/v1`);
`SCOUT_GATEWAY_MODELS` lists more for channels' profiles. spoond's
gateway serves only OpenAI's API and needs a lease id, so it isn't a good fit for Scout's own calls.

## Pi Durable: stable or main

Scout runs on the Pi Durable release `package.json` pins. `npm run pi -- main` builds Pi's main branch (or any branch,
tag or commit) from github.com/earendil-works/pi and installs it in place of the release, without saving: `npm ci`,
`npm install` or `npm run pi -- stable` go back. pi-env stays at its release. Scout logs which it runs on at start.

Main can change how `pi.sqlite` is stored, and a release can't open what it converted, so switching is one-way for a
data folder. Scout on main refuses to open data the release has used until you start it once with
`SCOUT_PI_MIGRATE=1`; back `pi.sqlite` up first, or try main on a copy (`SCOUT_DATA_DIR`). Back on the release, Scout
refuses converted data and says so.

## Pull request review

Request a review from Scout's code host account on a pull request in a configured repository, and Scout reviews it
like a colleague would: the profile's `reviewer.md`, the channel's instructions for that repository, read-only files
and the MCP tools (CI logs). It posts a real review (approve, request changes, or comment) with comments on the lines
the diff shows, then reviews each new push until the pull request closes. Its own pull requests are skipped (they had
their self-review). The channel whose profile names the repository gets a short summary, in a thread where anyone can
ask Scout about its review, or to fix what it flagged: that thread's sandbox has the pull request's branch, and a fix
opens as a pull request into it, so the author merges it or not (Scout never pushes to someone else's branch). A pull
request from a fork gets the base branch instead. Nothing to configure; give Scout's account access to the repository.

## CI on Scout's pull requests

Once a minute Scout reads the combined commit status of each of its open pull requests' heads (Forgejo Actions and
GitHub report there). Green, it says so in the pull request's thread. Red, the thread is asked to read the failing
job's log (the CI tools) and fix what its change broke, or say it isn't from its change; at most twice per pull
request, then Scout asks the person who requested the work to look. A commit nobody reports CI for within 15 minutes
is taken as having none. Fixes count against the channel's budget and concurrency.

Scout has its own runner for repositories that have no CI of their own: spoond's runner (`spoond runner`), run as
`scout-runner.service` next to Scout, registered with the label `scout`. A workflow asks for it with `runs-on: scout`;
each job gets a fresh microVM from Scout's spoond account, in the image Scout's sandboxes use (`IMAGE_MAP`), so
nothing a job runs touches Scout's host. Its settings are in `/opt/scout-runner/runner.env`; the registration token
(`runner-registration-token`) and the lease token (`spoond-token`) are files in Scout's config directory. The profile
tells Scout to use it when it writes a workflow, and to leave other repositories' runners alone.

## Alerts

Scout can watch the monitoring you already have and look into each new alert in public. It reads Gatus's checks
(`SCOUT_ALERTS_GATUS_URL`) and Grafana's firing alerts (`SCOUT_ALERTS_GRAFANA_URL` and `SCOUT_ALERTS_GRAFANA_TOKEN`,
a Viewer service account), once a minute. Your alerts' existing destinations are untouched. Where Scout reads alerts
from is yours to set; which ones it looks into is the profile's (below), so it can be changed by pull request.

- The first look only records what's already firing, and lists it in the alerts channel (`SCOUT_ALERTS_CHANNEL`, or
  else Scout's home channel, `SCOUT_REFLECT_CHANNEL`).
- Each new alert gets a message in the channel whose profile claims it (`alerts:` in its `instructions.md`: any of the
  alert's label values, or `label=value`; a Gatus check's labels are `group`, `name` and `endpoint`), or the alerts
  channel. Its thread is an investigation: the
  profile's `responder.md` says how. Scout mentions the channel's `oncall:` people.
- When the alert clears, Scout says so in the same thread. People can join, steer, or ask it to fix what it found.
- An alert that clears and comes back soon after (`returns_within`, six hours unless the profile says otherwise) is
  the same incident: Scout says so in its thread instead of opening another and investigating again.

The frontmatter of `responder.md` is the alert policy. Each key can be prefixed with a source (`gatus.`, `grafana.`),
which then overrides the same key without one for that source:

```yaml
---
ignore: name=Cloudflare OS                  # never posted
grafana.investigate: severity=critical      # the rest are posted, with a thread to ask in, but not looked into
gatus.down_after: 3                         # failed checks in a row before a Gatus check counts as down (default 2)
returns_within: 6h                          # 30m, 6h, 1d
---
```

`ignore` and `investigate` match like `alerts:` above. Scout logs a warning for a key or value it can't read, rather
than guessing, and applies changes on its next look.
- Investigations count against the channel's budget and concurrency like any request.

## Asking for behavior in the profile

Profiles are instructions in plain English, so behavior goes there: "when you've finished looking into an alert,
mention @jason with your verdict" in `responder.md`, or in one channel's `instructions.md`. `@name` in anything Scout
posts becomes a real Slack mention when it matches someone's handle or display name (not inside code).

## Tools beyond code: MCP servers

`SCOUT_MCP_FILE` lists MCP servers Scout runs on its host with their own credentials, never in a sandbox (the file's
shape is in `src/mcp.ts`). A server can be limited to some channels. Give Scout read-only access: a viewer account, a
read-only token.

**Changes go through code by default.** Scout offers only the tools a server marks read-only (MCP's `readOnlyHint`),
so what it may change lives in a repository and lands as a reviewed pull request: alert rules and dashboards as
provisioning files or Git Sync, infrastructure as Terraform. A server's `writes` setting changes that, for tools with
no configuration as code (a SaaS console, say):

- `"writes": "approve"`: tools that change things are offered, but a call waits until a person in the thread replies
  `approve` (alone; "I don't approve" never counts) or reacts 👍 or ✅ to the answer where Scout asked (only that one,
  and only until Scout answers again). Approvals are kept in `scout.sqlite`, so a restart loses none. The approver must be allowed to request work there (and be in a
  group `SCOUT_ROLES_FILE` names for that server). One approval covers one change, within 15 minutes; the next needs
  its own. The audit trail records each. Give the server credentials that can write.
- `"writes": "allow"`: every tool, no gate; for a trusted server that doesn't mark its tools.

- **Grafana**: Grafana Labs' [`mcp-grafana`](https://github.com/grafana/mcp-grafana) with `--disable-write` and a
  Viewer service account: metrics and logs queries, dashboards, alerts.
- **Forgejo CI** (`mcp/forgejo-ci.ts`): a repository's runs, a run's jobs, a job's log (tail or matching lines),
  with Scout's code host token; logs are redacted for credentials.
- **Gatus** (`mcp/gatus.ts`): what's failing now, and an endpoint's recent checks.

```json
{ "servers": {
    "grafana": { "command": "/usr/local/bin/mcp-grafana",
                 "args": ["--disable-write", "--usage-stats=disabled", "--enabled-tools", "search,datasource,prometheus,loki,alerting,dashboard,folder,annotations"],
                 "env": { "GRAFANA_URL": "http://grafana.lan:3000", "GRAFANA_SERVICE_ACCOUNT_TOKEN": "${GRAFANA_TOKEN}" } },
    "ci": { "command": "node", "args": ["mcp/forgejo-ci.ts"],
            "env": { "FORGEJO_API": "http://git.lan:3000/api/v1", "FORGEJO_TOKEN": "${SCOUT_CODEHOST_TOKEN}" } },
    "status": { "command": "node", "args": ["mcp/gatus.ts"], "env": { "GATUS_URL": "http://gatus.lan:8080" } } } }
```

## Backups: Litestream

Both databases (`pi.sqlite`, conversations; `scout.sqlite`, everything else) are SQLite in WAL mode.
`deploy/litestream.yml` replicates them continuously to object storage, and `deploy/scout.service` restores them
before start and runs Scout under Litestream.

To move to a new host: install Scout and Litestream, set `LITESTREAM_REPLICA_URL` and its credentials, and start the
service. The restore runs first, and Pi Durable resumes every unfinished run where it stopped. Sandboxes are not
backed up. Docker workspaces are re-cloned (uncommitted work in them is lost); spoond leases survive on spoond.

## Secrets

Any secret can be a reference instead of a value:

| Form | Reads |
|---|---|
| `NAME_FILE=/path` | a file (Docker or Kubernetes secrets), for the secret names in `src/secrets.ts` |
| `NAME=file:/path` | a file |
| `NAME=cred:name` | a systemd credential (`LoadCredential=name:/path`) |
| `NAME=op://vault/item/field` | 1Password, via the `op` CLI and `OP_SERVICE_ACCOUNT_TOKEN` |

`kill -HUP <pid>` reads them all again. The code host token, the gateway key and spoond's token take effect at once;
Slack tokens and MCP servers' credentials need a restart.

## Telemetry

- **Traces**: `SCOUT_OTLP_ENDPOINT` (an OTLP/HTTP endpoint ending in `/v1/traces`) and `SCOUT_OTLP_HEADERS` (JSON).
  Each run is a trace: a `scout.run` span with a child span for each model call (model, tokens, cost) and each tool
  call.
- **Metrics**: Prometheus text at `/metrics` on the dashboard's listener: model requests, tokens, spend, tool calls,
  runs, and gauges for working threads, open pull requests, unreviewed notes, problems, this week's spend and open
  sandbox connections. With `SCOUT_METRICS_TOKEN` it takes that bearer token; otherwise the dashboard's login.

## Who may ask for work

Roles live in the organization's identity provider (Authelia, Entra, Google Workspace), and Scout asks it rather than
keeping its own. Repository permissions come from the code host, which signs people in through that provider and maps
its groups to teams; everything else asks the provider's groups directly.

`SCOUT_REQUESTER_CHECK=enforce` means a person may start or steer work in a repository, or approve a change, only if
they can change the repository themselves:
- Scout finds their code host login through the identity provider: their Slack email, the person with that email,
  their username (`SCOUT_DIRECTORY=authelia-file` with `SCOUT_DIRECTORY_SOURCE`, a path or URL of Authelia's
  `users_database.yml`; password hashes are dropped as it's read). This needs Slack's `users:read.email` scope.
- `SCOUT_PEOPLE_FILE` maps Slack user IDs to logins directly (`{ "U0123ABC": "alice" }`), and wins over the directory.
- Scout asks the code host for each person's permission on the repository, and caches the answer for ten minutes.
- `SCOUT_ALLOWED_USERGROUP` can also limit requests to one Slack user group.

Everyone can still talk in threads. Their words are kept as context, and Scout tells them why it isn't acting on them.

`SCOUT_ROLES_FILE` gives roles by the identity provider's groups:
- `request`: who may ask for work (start, steer, approve) in a repository, by its name or `*`. With it, Scout checks
  groups instead of asking the code host, which tells only its own admins what permission someone else has.
- `approve`: who may approve changes made through tools (MCP servers with `writes: "approve"`), per server or `*`.

```json
{ "request": { "*": ["admins", "users"] }, "approve": { "*": ["admins"] } }
```

Merging and deploying stay with the code host: branch protection says who may merge, and deploys run from merges
and protected tags.

## Budgets and limits

`SCOUT_LIMITS_FILE`, owned by whoever runs Scout. It isn't in the profile, which Scout itself proposes changes to.

```json
{
  "weekly": { "total": 500, "perChannel": 50, "channels": { "data-team": 200 } },
  "perRun": { "maxToolCalls": 150, "maxCost": 10 },
  "concurrency": { "total": 8, "perChannel": 2 }
}
```

- **Weekly budgets** are dollars per calendar week, from Monday. Past a budget, new requests in that channel are
  declined until Monday.
- **Concurrency limits** queue requests: Scout says so, and starts them in order as runs finish. The queue survives
  restarts.
- **Per-run limits** stop a runaway request. Scout is told to summarize and ask before going on.

Spend comes from a ledger of every model response. Prices are pi-ai's catalog prices, unless `SCOUT_PRICES_FILE`
overrides them (dollars per million tokens):

```json
{ "anthropic/claude-opus-5-5": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25 } }
```

The dashboard shows this week's spend by channel against each budget.

## Audit trail and retention

Every request, stop, refusal, tool call, blocked call, pull request (opened and decided), note (kept and forgotten),
reflection and automated review is in an append-only table in `scout.sqlite`:
- Tool calls are recorded by name and arguments, never output, and anything that looks like a credential is redacted.
- The database refuses updates and deletes.
- Export with `npm run audit -- --since 2026-10-01 [--until …] [--kind tool]`, as JSON lines.

`SCOUT_RETENTION_DAYS` deletes what quiet threads leave behind after that many days: the sandbox, its files and
attachments, its words in the search index, and notes that stopped applying. The audit trail is kept.

Transcripts in `pi.sqlite` are not deleted yet: Pi Durable has no way to delete a conversation.

Before any pull request, its diff is scanned for credentials (private keys, AWS, GitHub, Slack, Anthropic, OpenAI,
Google and Stripe keys, tokens, passwords in URLs). Scout is sent back to remove any it finds. Notes are scanned the
same way.
