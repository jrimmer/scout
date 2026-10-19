# Scout design

Scout is a coding teammate that lives in Slack and works only in public. It is modelled on Shopify's River.
This document says what we're copying, how Scout is built, and what we left out on purpose.

## What River is

From Tobi Lütke's ["Learning on the Shop floor"](https://x.com/tobi/status/2053121182044451016) (May 2026) and
Shopify's ["Under the River"](https://shopify.engineering/under-the-river):

- **You talk to it like a teammate**: mention it in a Slack channel. It reads code, runs tests, writes code, opens
  pull requests, and queries data and production traces.
- **It works only in the open.** It declines direct messages and offers to create a public channel for you and it.
  Every conversation is searchable, and anyone can join a thread, add context, or redirect the work.
- **The point is learning.** People learn from watching each other work with it ("Lehrwerkstatt"). Shopify's merge
  rate went from 36% to 77% in two months without changing models: people watched where River got stuck and
  wrote down what it should have known.
- **Teams teach it.** "Every channel can pre-load the zones, skills, and instructions its team needs." Skills are
  files; one team's warehouse skill was reused by twelve others.
- **Architecture** (Aquifer, the platform under River):
  - **Session**: a durable, append-only log, and the canonical record.
  - **Harness**: the agent loop, which is disposable and runs outside the sandbox.
  - **Sandbox**: shell, files and repo, also disposable.
  - Their three lessons: separate the agent loop from the sandbox it works in; make agents multiplayer from the
    start; add each new agent as a profile (data), not a new platform.

## Shape

```text
Slack (Socket Mode) ─▶ slack.ts ─▶ bridge.ts ──submit──▶ Pi Durable harness ──▶ model
        ▲                              │                       │
        └────── render.ts ◀──events────┘                       ├─ profile.ts    system prompt, channel profile, skills, zones
                                                               ├─ coding tools  read/write/edit/bash ─▶ sandbox.ts (Docker, per thread)
                                                               ├─ codehost.ts   self-review, then push + pull request, on the host
                                                               ├─ search.ts     earlier threads
                                                               ├─ memory.ts     notes between reflections
                                                               └─ mcp.ts        warehouse, traces, CI… on the host

nightly:   reflect.ts ─▶ reflection conversation (profile files only) ─▶ pull request on the profile repo
           people review and merge ─▶ Scout pulls its profile ─▶ every thread's next request
polling:   pulls.ts (merge rate, weekly report) · automation.ts (labelled pull requests get a review)
one-off:   job.ts ─▶ the same agent, no Slack, nothing kept
```

| File | Role |
|---|---|
| `src/bridge.ts` | Slack thread ↔ conversation. Starts threads on mentions, follows them after, stops on request, declines private places. |
| `src/etiquette.ts` | What a thread message does: start work, steer running work, or note it for later. |
| `src/render.ts` | One Slack message per run: posted at start, edited with progress, replaced by the answer. |
| `src/sandbox.ts` | Per-thread clone and container; mirrors; file tools confined to a directory. |
| `src/codehost.ts` | `open_pull_request`, run on the host with host credentials, after a size check and self-review. |
| `src/review.ts` | The reviewer: a conversation that can only read, used before pull requests and for automation. |
| `src/profile.ts` | `profile/` as an extension, reloaded on change; kept pulled when it's a repository. |
| `src/reflect.ts` | The nightly learning loop: digest the day's threads and notes, propose profile changes. |
| `src/memory.ts` | `remember` and `forget`; notes retire when the reflection's proposal that covers them merges. |
| `src/search.ts` | Full-text search over what was said in Scout's threads. |
| `src/pulls.ts` | Every pull request Scout opens and what became of it; the weekly merge rate. |
| `src/automation.ts` | Pull requests with the review label get a review comment, once per commit. |
| `src/mcp.ts` | MCP servers' tools, run on the host, optionally per channel. |
| `src/threads.ts` | Thread ↔ conversation map, plus per-thread stats (River's `river_sessions`). |
| `src/scout.ts` | Everything but the front door: harness, extensions, workspaces, stores. |
| `src/main.ts` | The Slack service and its schedules. `src/job.ts` is the one-off front door. |

## Decisions

- **[Pi Durable](https://earendil.com/posts/pi-durable/) runs the agent.**
  - Each model call and tool call is a checkpointed task in SQLite, so a crash or deploy resumes mid-run.
  - Each conversation is the durable log River keeps. The harness and the sandbox can be thrown away.
  - Its multi-client steering is what lets a second person redirect work in progress.
  - Pinned to an exact version, because its API is experimental.
- **One Slack thread is one conversation.** Threads are independent pieces of work, so they don't fork a channel
  conversation. What should carry across threads goes in memory notes or the profile, where people can see it.
- **Scout follows whole threads**, not just mentions. That's what makes it multiplayer. `etiquette.ts` keeps it
  quiet when people are talking to each other:
  - While Scout is working, every message steers the work.
  - While idle, it replies to an @-mention, or to a reply from the person it was answering.
  - Anything else is recorded as context for the next request.

  Anyone can stop it: a stop-sign reaction or "@Scout stop" aborts the run, and kills what is running in its
  container.
- **One message per run, rendered from one place**, driven by the harness's event stream. Duplicate replies were
  what made Slack hard last time; this way there's nothing to deduplicate. Redelivered Slack events are absorbed by
  using the Slack message ID as the submission's `requestId`.
- **Isolation, not allowlists.** The agent gets a real shell, in a container that has nothing worth stealing:
  - It runs as the host user, with no capabilities and no network by default.
  - Only the thread's directory is mounted.
  - It gets no host environment and no credentials.

  File tools run on the host but resolve every path, symlinks included, against the thread's directory.
- **Credentials stay on the host.** Pushes, pull requests and MCP tools all run on the host.
  - The thread's repo is written by the agent, so the host never runs git inside it: its hooks and config are
    untrusted. A host-owned mirror fetches the branch from it and pushes.
  - Scout should have its own code host account and SSH key (`SCOUT_GIT_SSH_KEY`), so its work is its own and
    people review it like anyone else's.
- **Second look before people look.** Tobi's worry about agents is "slop grenades": output sent to colleagues who
  don't read it closely. So before any pull request:
  - Scout reviews its own diff in a separate conversation that can only read the workspace (`review.md`).
  - Findings send it back to fix them, unless it explains in the description why not.
  - Changes over `SCOUT_PR_MAX_LINES` are refused, with a request to split them.
- **Profiles are files in git**, so improving Scout is a reviewed change like any other:
  - `profile/system.md`, `reflect.md`, `review.md`, `skills/`, and `channels/<name>/` for a team's instructions,
    skills, repository and zones.
  - The repository's own AGENTS.md files still apply.
  - Edits reach every thread at its next request.
- **Scout drafts its own lessons; people merge them.** This is the learning loop:
  - Every night, a reflection conversation reads each thread with new activity: who asked what, what Scout did,
    which steps failed, and how it ended. It also reads Scout's notes, and which of its earlier proposals people
    merged or closed.
  - It edits a clone of the profile repository, then opens a pull request explaining each change with the thread
    it came from.
  - Scout keeps its live profile pulled, so a merged change reaches the next request in every thread, and the notes
    it covered retire.

  This copies how River's merge rate went from 36% to 77% without a model change: people noticed where it got
  stuck and wrote down what it should have known. Scout drafts that writing, and people review it. The weekly report
  of the merge rate says whether it's working.

  The reflection has file tools only, with no shell, and can't touch `.git`. The host commits on its behalf, with
  hooks off. It runs as an ordinary Pi Durable conversation, so it is checkpointed like everything else and
  exactly-once per day.
- **One agent, three ways in**, as in Aquifer: interactive (Slack threads), automation (labelled pull requests) and
  job (`npm run job`). They share the session model, workspaces and tools; each is a few dozen lines of front door.
- **One process, SQLite, Socket Mode.**
  - No tunnel, no Postgres, no job queue.
  - Pi Durable has one storage owner per process, which suits a team-sized deployment. Jobs use their own memory
    storage.
  - Scale out later by sharding channels across processes, if ever needed. Automation polls the code host, since
    there is no public address for webhooks.

## Left out on purpose

The first Scout (`scout-legacy`, archived) had about 82k lines of Go for roughly what this does. We left these out:

- **Hexagonal ports and architecture tests.** A small codebase with one composition root doesn't need enforcement
  machinery.
- **Approved command IDs instead of a shell.** River runs bash; the container is the boundary.
- **Plan and build modes, and authority snapshots.** Whether work lands is decided by pull request review.
- **An outbox, River Queue, and Postgres.** Pi Durable's tasks and `requestId` already give durable, exactly-once
  steps.
- **An admin UI, an embedded LLM gateway, per-channel virtual filesystems, analytics, and timing waterfalls.**

## Known gaps

- **Symlink race.** The file tools check the path, then use it. A process in the container that swaps a symlink in
  between could redirect a host-side read or write. The fix is to run the file tools in the container too.
- **Stopping kills everything in the thread's container**, not just the stopped command. Fine while one thread has
  one container.
- **No sandbox network by default.** Repos that download dependencies need `SCOUT_SANDBOX_NETWORK`, or an image
  with the dependencies baked in. Scout is told when it's offline, so it says so instead of looking broken.
- **Automation can't review pull requests from forks** unless the code host mirrors their heads
  (`refs/pull/*/head`); the review is skipped with a log line.
- **Attachments are ignored.**
- **Progress after a restart.** A run that resumes after a restart posts a new progress message instead of editing
  the old one.
- **Two open profile proposals can conflict.** The reflection sees which earlier proposals merged or closed, but
  not their review comments.

## Next

- **Run it for real.** Nothing here has met a live Slack workspace, a real model, or Docker on this machine. The
  first week will say more than more features would.
- **Watch for Earendil's Pi Slack bot.** If it lands, adopt what fits for the Slack plumbing, and keep the profile,
  sandbox, review and learning loop.
- **Learn from review comments**, not just merged or closed: the most specific feedback Scout gets is on its pull
  requests.
- **Run the file tools in the container** to close the symlink race.

## Maybe later

- **[LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs)**: copy-on-write workspaces with per-tool-call commits.
  It would pair with Pi Durable's forks (fork the conversation *and* the files), and make per-thread copies of a
  huge monorepo cheap. Not before its 1.0; `git clone` from a local mirror is enough for now.
- **hrmny**: its Discord-compatible API means a thin Discord adapter would also run on hrmny. Its machine-principal
  model is a good reference for Scout's identity: a bot is its own identity, with narrowing grants and no
  impersonation of its owner.
- **louisiane** (`../sncan`): a bridge so local Claude Code or pi sessions can hand work to Scout and back. Its
  reply rules already shaped `etiquette.ts`.
