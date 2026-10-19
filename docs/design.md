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
        └────── render.ts ◀──events────┘                       ├─ profile.ts    system prompt, channel profile, skills
                                                               ├─ coding tools  read/write/edit/bash ─▶ sandbox.ts (Docker, per thread)
                                                               └─ codehost.ts   push + pull request, on the host

nightly: reflect.ts ─▶ reflection conversation (profile files only) ─▶ pull request on the profile repo
         people review and merge ─▶ Scout pulls its profile ─▶ every thread's next request
```

| File | Role |
|---|---|
| `src/bridge.ts` | Slack thread ↔ conversation. Starts threads on mentions, follows them after, declines private places. |
| `src/etiquette.ts` | What a thread message does: start work, steer running work, or note it for later. |
| `src/render.ts` | One Slack message per run: posted at start, edited with progress, replaced by the answer. |
| `src/sandbox.ts` | Per-thread clone and container. File tools confined to the thread's directory. |
| `src/codehost.ts` | `open_pull_request`, run on the host with host credentials. |
| `src/profile.ts` | `profile/` as an extension, reloaded on change; kept pulled when it's a repository. |
| `src/reflect.ts` | The nightly learning loop: digest the day's threads, propose profile changes. |
| `src/threads.ts` | Thread ↔ conversation map, plus per-thread stats (River's `river_sessions`). |
| `src/main.ts` | Wiring. The only place concrete things are put together. |

## Decisions

- **[Pi Durable](https://earendil.com/posts/pi-durable/) runs the agent.**
  - Each model call and tool call is a checkpointed task in SQLite, so a crash or deploy resumes mid-run.
  - Each conversation is the durable log River keeps. The harness and the sandbox can be thrown away.
  - Its multi-client steering is what lets a second person redirect work in progress.
  - Pinned to an exact version, because its API is experimental.
- **One Slack thread is one conversation.** Threads are independent pieces of work, so they don't fork a channel
  conversation. Anything that should carry across threads goes in the profile, where people can see and edit it.
- **Scout follows whole threads**, not just mentions. That's what makes it multiplayer. `etiquette.ts` keeps it
  quiet when people are talking to each other:
  - While Scout is working, every message steers the work.
  - While idle, it replies to an @-mention, or to a reply from the person it was answering.
  - Anything else is recorded as context for the next request.
- **One message per run, rendered from one place**, driven by the harness's event stream. Duplicate replies were
  what made Slack hard last time; this way there's nothing to deduplicate. Redelivered Slack events are absorbed by
  using the Slack message ID as the submission's `requestId`.
- **Isolation, not allowlists.** The agent gets a real shell, in a container that has nothing worth stealing:
  - It runs as the host user, with no capabilities and no network by default.
  - Only the thread's directory is mounted.
  - It gets no host environment and no credentials.

  File tools run on the host but resolve every path, symlinks included, against the thread's directory.
- **Credentials stay on the host.** The thread's repo is written by the agent, so the host never runs git inside it,
  because its hooks and config are untrusted. Instead, a host-owned mirror fetches the branch from it and pushes.
  Pull request descriptions link back to the Slack thread.
- **Profiles are files in git**, so improving Scout is a reviewed change like any other:
  - `profile/system.md`, `profile/skills/`, `profile/channels/<name>/`.
  - The repository's own AGENTS.md files still apply.
  - Edits reach every thread at its next request.
- **Scout drafts its own lessons; people merge them.** This is the learning loop:
  - Every night, a reflection conversation reads each thread with new activity: who asked what, what Scout did,
    which steps failed, and how it ended.
  - It edits a clone of the profile repository, then opens a pull request explaining each change with the thread
    it came from.
  - Scout keeps its live profile pulled, so a merged change reaches the next request in every thread.
  - How it reflects is itself profile data (`reflect.md`), so the team can tune how Scout learns.

  This copies how River's merge rate went from 36% to 77% without a model change: people noticed where it got
  stuck and wrote down what it should have known. Scout drafts that writing, and people review it.

  The reflection has file tools only, with no shell, and can't touch `.git`. The host commits on its behalf, with
  hooks off. It runs as an ordinary Pi Durable conversation, so it is checkpointed like everything else and
  exactly-once per day.
- **One process, SQLite, Socket Mode.**
  - No tunnel, no Postgres, no job queue.
  - Pi Durable has one storage owner per process, which suits a team-sized deployment.
  - Scale out later by sharding channels across processes, if ever needed.

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

- **Stopping work doesn't reach the container.** Aborting a command kills the local `docker exec`, not the process
  in the container. Command timeouts are enforced inside the container, so runaway processes still end.
- **Symlink race.** The file tools check the path, then use it. A process in the container that swaps a symlink in
  between could redirect a host-side read or write. The fix is to run the file tools in the container too.
- **One repository per install.** No multi-repo threads yet.
- **No stop control yet.** River-style: a reaction or "@Scout stop" should call `conversation.abort()`.
- **Attachments are ignored.**
- **No sandbox network by default.** Repos that download dependencies need `SCOUT_SANDBOX_NETWORK`, or an image
  with the dependencies baked in.
- **Progress after a restart.** A run that resumes after a restart posts a new progress message instead of editing
  the old one.
- **The reflection only sees new threads.** It doesn't know which of its earlier proposals were merged or
  rejected, and two open proposals can conflict. Telling it would make it learn from review too.

## Next

What the research describes that Scout doesn't do yet, roughly in order of value:

1. **Measure the merge rate.** River's headline number is the share of its pull requests that merge (36% → 77%).
   Scout records its pull request URLs per thread; poll their state and report the rate weekly. Without it, we
   can't tell whether the learning loop works. Tell the reflection which of its own proposals merged, too.
2. **Stop control.** A reaction or "@Scout stop" calls `conversation.abort()`. Small, and people expect it.
3. **Search past threads.** "The next person who has the same question does not have to ask it." Give Scout a
   tool over its own transcripts, so it can point at the thread where something was solved before.
4. **Tools beyond code**, through MCP (Pi 1.0 supports it): the data warehouse, production traces, CI status.
   Each runs on the host with its own credentials, like `open_pull_request` (Aquifer's credentials proxy), never in
   the sandbox.
5. **Memory between nightly reflections.** Tobi says River's memory is "constantly learning and un-learning". The
   nightly loop covers the slow, reviewed part. A small per-channel memory Scout can update during a thread (and
   that the reflection consolidates) would cover the fast part.
6. **Self-review before a pull request.** Tobi's worry is "slop grenades": output sent for review that nobody
   read closely. A reviewer pass in its own conversation (Pi Durable's `28-reviewer` example) before
   `open_pull_request`, plus a size limit on what Scout will propose.
7. **Other modes.** Aquifer runs the same session model as *automation*, such as a pull request review woken by a
   webhook, and as *job*, for CI and batch work. Both are new profiles on the same machinery, not new platforms.
8. **Multiple repositories and zones.** River knows which "zones" of the monorepo a channel's team owns. Map
   channels to repositories, or monorepo paths, in the channel profile.
9. **Watch for Earendil's Pi Slack bot.** If it lands, adopt what fits for the Slack plumbing and keep the profile,
   sandbox and learning loop.

## Maybe later

- **[LayerFS](https://github.com/Ephemeral-AI-Lab/layerfs)**: copy-on-write workspaces with per-tool-call commits.
  It would pair with Pi Durable's forks (fork the conversation *and* the files), and make per-thread copies of a
  huge monorepo cheap. Not before its 1.0; `git clone` from a local mirror is enough for now.
- **hrmny**: its Discord-compatible API means a thin Discord adapter would also run on hrmny. Its machine-principal
  model is a good reference for Scout's identity: a bot is its own identity, with narrowing grants and no
  impersonation of its owner.
- **louisiane** (`../sncan`): a bridge so local Claude Code or pi sessions can hand work to Scout and back. Its
  reply rules already shaped `etiquette.ts`.
