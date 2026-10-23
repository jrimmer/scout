# Security model

Scout is a coding agent that takes requests from people in Slack and on a code host, runs code, and opens pull
requests. This is what it can reach, what it can't, and what to watch for. It assumes the setting it was built for:
one company, its own repositories, colleagues in its channels.

## Principles

- **Public only.** Scout works in public Slack channels and nowhere else: it declines DMs and private channels, so
  everything it does can be watched, and anything it says, anyone in the channel could read.
- **Credentials stay on the host.** The code host token, the SSH key, Slack's tokens, model keys and MCP servers'
  credentials live on the host that runs Scout. Sandboxes get none of them.
- **People decide what lands.** Scout opens pull requests; people merge them. Its own profile is a repository whose
  main branch it can't push to. Changes made through tools (MCP servers with `writes: approve`) and network access
  for sandboxes need a person's approval, by name, recorded in the audit trail.
- **Everything is audited.** Requests, tool calls, approvals, refusals, pull requests and their outcomes go to an
  append-only audit trail (`npm run audit`).

## What each part can reach

| Part | Can reach | Can't |
|---|---|---|
| The Scout service | Slack (its bot), the code host (its own account), the model provider or gateway, the sandbox API, MCP servers, its own database | Anything it isn't configured for |
| A thread's sandbox | Its own clone of one repository; the network its repository's egress list allows (or none, or open, per settings) | Credentials, the code host, other threads' sandboxes, the host |
| The model | What's in the conversation: the request, the thread, tool results, the profile | Anything else; it acts only through tools |
| MCP servers | Whatever their own credentials allow; offered per channel; writes off, behind approval, or allowed, per server | Sandboxes |

Git crosses between host and sandbox only as bundles: the host's mirror makes one of the base branch for the
sandbox, and the sandbox makes one of its commits for the host to push. The host never runs git inside a sandbox's
clone; it never pushes over someone else's commits on Scout's branches.

## Prompt injection

Text Scout reads can try to tell it what to do: a Slack message, an issue or comment on the code host, a file in a
repository, a web page, a tool's output. Scout treats it as data, but a model can be talked into things. What limits
the damage:

- **Who may ask** is checked for every request: in Slack by the person's identity, on the code host by their login
  (looked up in the directory). A comment from someone who may not ask is answered with a polite no, not acted on.
- **The sandbox** holds nothing worth stealing and reaches only what its egress list allows; exfiltration needs a
  host on that list.
- **Approvals** gate tool writes and network access; Scout's own requests are never enough.
- **Pull requests** are reviewed by people before anything reaches a base branch, and Scout reviews its own diff
  first (including for things that look like credentials, which it refuses to push).
- **Notes Scout keeps** are shown with its answers so people can object, expire unless reviewed, and are framed to
  the model as hints, never instructions.

Be careful with public repositories (anyone can open an issue or comment) and with MCP servers that can write:
keep those behind approval.

## The dashboard

The dashboard is the only thing Scout listens on, and it shows what Scout is doing: channels, the last step of each
run, notes, schedules, pull requests. It speaks plain HTTP.

- **On loopback** (the default) it has no login and answers only requests addressed to a loopback name (`localhost`,
  `127.0.0.1`, `[::1]`), which stops a web page from reading it through DNS rebinding. Anyone with a shell on the
  host can still read it.
- **Off loopback** it requires a login, and the login and the metrics token cross the network in the clear with every
  request. Put it behind a reverse proxy that speaks TLS, or keep it on a private network (WireGuard, Tailscale).
  Logins are checked one at a time, off Scout's event loop, so a flood of wrong passwords can't stall Scout.
- **The metrics token** (`SCOUT_METRICS_TOKEN`) opens `/metrics`, and the part of `/status.json` the doctor needs:
  no notes, schedules, threads or steps, and problems and model errors with credentials redacted. Everything else needs
  the login.
- `/healthz` answers `ok` to anyone, and says nothing else.

## Slack files

A file shared in a thread is fetched with Scout's bot token only from Slack's own file host (`https://files.slack.com`),
redirects included. A remote file's link can point anywhere, so Scout doesn't follow it with the token; it says it
couldn't download the file. What it reads is capped by the bytes that actually arrive, not the size Slack reports.

## Data

Thread transcripts, notes, schedules and the audit trail are in Scout's data directory (SQLite). Retention
(`SCOUT_RETENTION_DAYS`) deletes what quiet threads leave behind; transcripts in Pi Durable's store are not yet
deleted. Back the data directory up (see operations.md, Backups).

Answers to requests made on the code host are posted back there: in full on private repositories, only a pointer to
the Slack thread on public ones, since an answer can draw on anything said in Slack.

## Reporting

If you find a way to make Scout act outside these limits, report it privately to whoever maintains your deployment
before posting it anywhere public.
