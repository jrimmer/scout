# Running Scout

Everything here is optional beyond the basics in the README; `.env.example` lists every setting.

## Is everything set up right? `npm run doctor`

`npm run doctor` (with the same `.env` as the service), or `/scout doctor` in Slack, checks everything Scout depends
on and prints one line each, ✅, ⚠️ or ❌, with how to fix what isn't (`src/doctor.ts`):

- the settings load;
- Slack: the token, the scopes Scout can't do without, and which features are off for want of others;
- the code host: the token, and its scopes (on Forgejo, that it can read notifications; on GitHub, `repo` and
  `notifications` for classic tokens);
- spoond, when it's the sandbox driver: reachable, and the token accepted;
- the model gateway: answering, and serving the configured models;
- every repository and the profile repository: reachable over git with Scout's SSH key, with their branch;
- the directory: readable, with people in it;
- the MCP servers: each connects, and how many tools they offer;
- the dashboard: not open to the network without a login.

It exits 1 when anything is broken, so it can gate a deploy.

## Is it working? The canary

The doctor checks that things are reachable. The canary checks that Scout actually does the work. Once a night, `npm run canary` does what a person would:
1. It asks Scout, in a channel kept for this, to add a line to `CANARY.md` and open a pull request.
2. It waits for Scout's answer (5 minutes by default, `SCOUT_CANARY_REPLY_MINUTES`) and for the pull request (45 minutes, `SCOUT_CANARY_PULL_MINUTES`).
3. It checks that the pull request changes that file.
4. It closes the pull request and deletes its branch.

**What it covers.** It runs outside Scout, as a person in Slack, so it notices anything that stops Scout from working: Slack, the model, sandboxes, the code host, or Scout not running at all. It uses the real model, so it costs one small request a night.

**What it needs:**
- **A Slack user for the canary**, with a user token (`SCOUT_CANARY_SLACK_TOKEN`). It needs the scopes `chat:write` and `channels:history`.
  - Scout ignores messages from bots, so this has to be a person's account.
  - That account must be allowed to ask Scout for work (see "Who may ask for work").
- **A public channel** that works in a throwaway repository: `SCOUT_CANARY_CHANNEL` (its id) and `SCOUT_CANARY_REPO` (`owner/name`).
- **Scout's Slack user id**, to mention it: `SCOUT_CANARY_SCOUT_USER`.
- **A code host token** that can close pull requests and delete branches in that repository: `SCOUT_CANARY_CODEHOST_TOKEN`. Also set `SCOUT_CODEHOST` and `SCOUT_CODEHOST_API` as for Scout.
- **Optionally, a monitor to tell:** `SCOUT_CANARY_REPORT_URL`, with `SCOUT_CANARY_REPORT_TOKEN` as a bearer token.
  - The canary POSTs `success`, `error` and `duration` to it.
  - That is exactly what a Gatus external endpoint takes, so a failed night alerts like any other check.

**Running it.** `.forgejo/workflows/canary.yml` runs it each night on Scout's CI runner. It reads the tokens from the repository's secrets and the rest from its variables, and it does nothing until `SCOUT_CANARY_SLACK_TOKEN` is set. Anything else that runs a command on a schedule works too: it exits 1 when the check fails.

## How much Scout does on its own

`SCOUT_INITIATIVE` (`asked`, `own`, or `team`, the default) sets how much Scout does without being asked
(`src/initiative.ts`); see the table in [setup.md](setup.md#9-how-much-scout-does-on-its-own). Every proactive
feature checks it before acting: `own` covers Scout's own work (CI fixes, mergeability, its quiet pull requests and
branches, follow-ups, images, reviewer requests, the reflection), `team` the team's (alerts, review reminders, the
weekly report and summaries, canvases, the work list, link previews). Requests from people are never affected.

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

In REST mode Scout also watches that a command is really running. spoond can take a command and lose it on the way into the sandbox, or lose the sandbox under a running command. Either way it would report the command as running until its 24-hour cap. Scout checks for itself:
- **Starting.** Every command first leaves a marker in the sandbox. A command still "running" after 20 seconds with no marker never started, and the thread hears to run it again. spoond 3.12.1 and later notice this themselves and mark the command lost. Scout reads that too.
- **While it runs.** Scout checks every minute that the sandbox still answers. After five minutes without an answer, it stops waiting and says the sandbox has probably crashed. A sandbox that answers is never cut short, however long the command takes.

When spoond is nearly full it answers new leases with "wait" or "full", and Scout retries for up to ten minutes
before the thread hears that no sandbox was free. spoond also pauses leases to keep memory free; a paused lease
resumes on its next use, so a thread's first command after a quiet spell can take longer.

### When a sandbox can't reach a host

A sandbox that can't reach something it needs (DNS failures, refused or timed-out connections during an install)
doesn't diagnose itself or work around the network: Scout calls `ask_for_network` with the host and what needed it
(`src/egress.ts`). Its home channel gets the question, with the thread's link and Allow and Decline buttons. Only
people in the `egress` approvers of `SCOUT_ROLES_FILE` (`"approve": { "egress": [...] }`, or else `"*"`) may decide;
anyone else pressing a button is told why, just to them. Allow adds the host to the repository's egress list in the
repos file (`SCOUT_REPOS_FILE`; a backup is kept as `.bak`, and the file is replaced in one step) and in memory, so
new sandboxes get it at once. Sandboxes already running keep their network: the thread is told a new thread gets it.
A repository configured in the environment rather than the repos file gets it until Scout restarts, and the decision
message says to add it to `SCOUT_REPO_EGRESS`. Each host is asked about once per repository while it waits, and both
the request and the decision are in the audit trail.

### Repository images

A repository can carry `.scout/setup.sh` on its base branch: what gets a fresh sandbox ready to work (toolchain,
dependencies, a first build). On spoond, Scout builds an image from it, `scout/<repo>` (`src/images.ts`):
- In a temporary sandbox from the repository's configured image or snapshot (with its egress list, or else open
  network, since setup downloads things), Scout clones the base where threads keep their checkout and runs the script
  there, with up to an hour.
- It saves the result as a named snapshot, keeping the last 3 versions.
- New threads in that repository start from the image. Instead of cloning, they fetch the latest base into the
  prebuilt checkout and start their branch, so what the script built (ignored by git) is already there.
- Scout rebuilds when the script changes on the base branch, and weekly. A failed build is reported on the dashboard,
  threads keep starting from the last good image, and the same script is tried again after an hour.

Scout's CI runner will start jobs from the same image (`runs-on: scout-<repo>`) once spoond's runner can start jobs
from a named snapshot (#24).

## In Slack: nothing lost, and always saying where things stand

Slack doesn't tell an app its plan, so Scout finds out what the workspace allows (`src/capabilities.ts`): the scopes
the app was granted (from Slack's answer at start), and for features a plan may not include (Lists, canvases) the
first real call. At start it logs one line per feature, on or off and why ("needs the reactions:write scope: update
the app from slack-manifest.yaml and reinstall", "this workspace doesn't allow it (paid_teams_only)"), and records
the same in the audit trail. A feature the plan refused is tried again a day later. Everything else works the same
either way.

- **Missed messages.** Socket Mode doesn't replay what was said while Scout was down. Scout records a heartbeat
  every minute; on start it reads back, since the last one (at most 6 hours), the top-level messages in the public
  channels it's in and the replies in its threads active in the last week, and takes them in order. A message it
  had already handled isn't handled twice: each request is keyed by its message.
- **Answers always arrive.** If the run's message can't be edited, the answer is posted anew. A message still saying
  "Working…" after a restart, whose run finished meanwhile, gets that answer ("Finished while I was restarting.").
- **Long answers.** Over 6,000 characters, the message shows the answer's first paragraph and the whole answer is
  attached as `answer.md` (needs the `files:write` scope); without it, the answer follows in several messages.
- **Saying where things stand.** The progress message has a status line, in Scout's own words: waiting its turn
  (and where in line), taking longer than usual (the model is being retried), or a step that's run for a while
  ("Still on `mix test`, 23 minutes in"). A run that starts soon after another had to wait on the model warns that
  Scout is slow today. Model calls are retried up to six times, backing off from 5 s to a minute, about three
  minutes in all.
- **Progress edits are paced across the workspace.** Slack allows about one `chat.update` a second per workspace,
  so every thread's progress edits share one pace (`ProgressPacer` in `src/render.ts`): with a few threads working,
  each message updates about every 1.5 s; with many, the total stays under one edit a second and each message
  updates less often, oldest change first, and only its latest state is sent. The rate wins over freshness: past
  about ten working threads a message can go more than 10 s between updates. Answers skip the pace, go out at once,
  and replace any progress edit still waiting, so an answer is never held back or overwritten.
- **Stuck runs.** After 10 minutes without a new step the status line says what Scout is still doing. After 45
  minutes with nothing running (no command in progress, no answer), the run stops with where it got to. A long
  command is never stopped this way; it has its own timeout.
- **Edits and deletions.** Editing a request that's waiting its turn replaces it; editing it while Scout works on it
  steers the run ("ann edited her request: …"). Deleting a waiting request drops it. Edits after Scout has answered
  are left alone: ask again.
- **"What are you working on?"** Asked in any thread, Scout answers from its live state (`scout_status`): what it's
  running and for how long, what's waiting to start, threads waiting on people, and the channel's schedules. Its
  **App Home tab** shows each person the same, plus their own threads and what each is waiting on, approvals and
  questions waiting on them, and the schedules they set up (`src/home.ts`).
- **"Ask Scout about this"**, from any message's ⋯ menu: a short form asks what to do, then Scout starts a thread on
  that message (an alert, a teammate's question) as a request from whoever asked. Only in public channels Scout is
  in; elsewhere the form says so.
- **Reactions on requests.** The request's reaction shows what Scout is doing, so the channel says it at a glance
  (`reactions:write`; `src/reactions.ts`): 👀 picked up, ⏳ queued, 🧠 thinking, 📖 reading, ✏️ editing, 💻 a command,
  🧪 testing, 🏗️ building, 📊 checking monitoring or CI, 🔀 opening the pull request, 🗜️ tidying its memory, 🐢 taking
  longer, ⚖️ trying approaches; at the end ✅ answered, ⚠️ a problem, ✋ stopped, 🙋 waiting on someone. One reaction
  at a time, Scout's own. Smoothed so it doesn't flicker: a phase shows once it has lasted 1.5 s and stays at least
  3 s; the ending shows at once and nothing overwrites it. Changes across the workspace go out at most every 1.5 s,
  only the latest per message, so a busy channel sees fewer changes rather than Slack rate limits. The profile's
  `reactions.md` renames any emoji; `SCOUT_STATUS_REACTIONS=off` goes back to just 👀, then ✅ or ⚠️.
- **🔍 to ask for a look.** A 🔍 on any message in a public channel Scout is in starts a thread on it: "look into
  this", as a request from whoever reacted.
- **Approve and Decline buttons.** When Scout's answer asks for approval of a change, a message with Approve and
  Decline follows (👍 on the answer still works). Pressing one goes through the same checks as replying "approve";
  the buttons then give way to who decided, or why they couldn't.
- **`/scout`**: `status`, `schedules`, `waiting` (what's waiting on you) answered just to you, and `ask …` to start a
  thread without an @mention.
- **Link previews.** A pull request or issue link to a repository Scout works in (on the domains in the manifest's
  `unfurl_domains`) previews with its state, author, CI, requested reviewers, and Scout's thread if it has one.
- **Each repository channel's canvas.** "Scout in #web": open pull requests, threads waiting on someone, schedules,
  and the notes Scout kept, refreshed every six hours and on Mondays. Where a channel has one, its Monday summary
  keeps to the week's numbers and points to the canvas (`canvases:write`).
- **The list of Scout's work.** A Slack List with one row per thread: request, channel, who asked, state, pull
  request, CI and cost, kept up to date as the work moves, shared read-only with the home channel (`lists:write`;
  paid plans).
- **The Ask Scout workflow step.** Workflow Builder (paid plans) gets a step that starts a Scout thread in a public
  channel with a request, and outputs the thread's link. Its "Asked by" is required and checked like any request;
  note that whoever builds the workflow chooses it, so the thread says the request came through a workflow.
- **🔁 to try again.** A 🔁 (`:repeat:`) on Scout's latest answer in a thread asks it to try again, as if the person
  had asked in the thread (so it's admitted and audited like any request).

## Model gateway

`SCOUT_GATEWAY_URL` sends model calls to a gateway (Bifrost, LiteLLM, Cloudflare AI Gateway) instead of the provider,
with `SCOUT_GATEWAY_KEY` and any `SCOUT_GATEWAY_HEADERS` (JSON) on every request. Model names don't change. A model only
the gateway knows is `gateway/<its name>` (`SCOUT_MODEL=gateway/lunaroute/deepseek-4.1-flash`), spoken to with
OpenAI's chat completions API at `SCOUT_GATEWAY_URL` (the gateway's OpenAI base, e.g. `https://llm.example.com/v1`);
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

## Code across repositories

Any thread can search and read the code of every repository Scout is set up for, not only the one it has checked
out (`src/codesearch.ts`): `search_code` (text or a regular expression, optionally one repository or a path glob,
`repo:path:line: text`) and `read_code` (a file, with line numbers, or a range of it). Both answer from the host's
bare mirrors with `git grep` and `git show` on each repository's base branch, fetched first when a mirror is more
than five minutes old: exact, current, read-only, and nothing new to run. `SCOUT_CODE_SEARCH=off` turns them off.

This isn't a code index. One becomes worth it with very large repositories (where `git grep` slows down), questions
by meaning rather than text, or cross-repository go-to-definition (#59); it would sit behind the same two tools.

## Trying several approaches (experimental)

When someone asks Scout to try or compare a few ways of doing something ("try a cache, or fixing the query"), it
can work on 2 to 4 approaches at once (`src/approaches.ts`, the `try_approaches` tool). It does this only when
asked: the profile tells it so, and it says the cost first, about one request's worth per approach.

- **Each approach** gets its own conversation (owned by the thread's run, so stopping the thread stops them all) and
  its own sandbox, starting from the thread's last commit (uncommitted work has to be committed first). It's told to
  implement only its approach, run the tests, commit, and report what it changed and its trade-offs, without
  opening a pull request.
- **One message in the thread compares them** as they go, a line per approach (working, done, or didn't finish;
  tests; diff size; cost), then each one's trade-offs and a "Use" button per approach that finished.
- **Choosing** (checked like any request from whoever presses it) brings that approach's commits onto the thread's
  branch, removes all the approaches' sandboxes, and tells the thread, which carries on from there (for example,
  opening the pull request when asked). Nobody choosing leaves them until retention cleans up.
- **Cost** counts against the channel's budget, and each approach answers to the per-run limits on its own.

- **Run limits** apply: each approach counts as a run. When the limits leave room for fewer than asked, the
  rest wait (⏳ "waiting for room" in the comparison, which says so) and start as the others finish.

`SCOUT_PARALLEL=off` turns it off. What's rough: the thread's own run and its first approach share one slot, a
waiting approach's model waits don't show in the thread's message, the live lines show elapsed time and cost but not steps, and Scout won't suggest it on its own yet.

## Work from the code host

Once a minute Scout reads its code host account's unread notifications (Forgejo and GitHub both keep them) and looks
at what's new on each issue or pull request they point at (`src/forge.ts`). These ask Scout for something:

- an issue assigned to Scout;
- `@scout` (Scout's login) in a new issue or pull request, or in a comment, review or comment on a line;
- on a pull request Scout opened, a review asking for changes, with its comments on lines.

Other things people say on Scout's own pull requests (comments, reviews, comments on lines, each with its file and
line) are context: they're quoted in its thread and the conversation knows them, but Scout doesn't act on them,
the way it treats a reply in Slack that isn't addressed to it. A bare approval is nothing. On other people's pull
requests, only mentions count.

Each issue or pull request has one thread: the one that opened Scout's own pull request, the review thread of one
Scout reviewed, or the one an earlier request there started. A request goes to that thread, quoted there so people
in Slack see it. Otherwise Scout starts a thread in the repository's channel (or the alert channel, when the
repository has none) and comments on the issue with a link to it. For someone else's pull request in the same
repository, the thread's changes go into that pull request's branch. Scout reacts 👀 to the comment (or issue)
that asked when it picks it up, and when it's done its answer goes back as a comment: in full on a private
repository, but on a public one (or one whose visibility the code host won't say) only a pointer to the Slack
thread and any pull request it opened, since an answer can draw on anything said in Slack (#40).

A reflection's proposal gets a thread too: its announcement in the home channel. Comments on the pull request, and
requests in that thread, go to the reflection that wrote it, which revises the same pull request. Revisions don't
announce again.

The account's token needs `write:notification` (Forgejo) or the `notifications` scope (GitHub classic tokens) as well
as access to issues and repositories.

Who may ask is decided as for Slack: the login is looked up in the directory and its groups checked against
`SCOUT_ROLES_FILE`, or, without roles for the repository, the code host's own permission. Someone who may not, or a
repository Scout isn't set up for, gets a short reply saying why. Nothing from before the inbox was first switched on
becomes work, and each comment is a request at most once. The code host is behind an interface (`Forge`); Forgejo
and GitHub share one implementation, with their differences in a small dialect.

## Other people's commits on Scout's branches

Teammates can push straight onto a branch Scout's pull request comes from, and Scout won't erase their work. Before
each push the host compares the branch on the code host with what Scout would push: Scout may replace its own
commits (a rebase, an amend), but if the push would drop anyone else's, it doesn't push. Instead their commits are
brought into the thread's clone as `origin/<branch>`, and Scout is asked to merge them in (not rebase over them), run
the tests and push again, and to say whose work it built on. A reflection's clone, which has no shell, gets them
merged for it when they merge cleanly, and is told to leave the pull request for a person when they conflict. Pushes
are leased (`--force-with-lease`), so a commit pushed while Scout was getting ready is never overwritten either.
Commits are told apart by author email: Scout's is `SCOUT_GIT_EMAIL`.

## Looking after its pull requests

Every few minutes Scout looks at its own open pull requests on the code host (`src/upkeep.ts`):

- **Kept mergeable.** When the base has moved and one no longer merges cleanly, Scout brings the base's latest
  commits into the thread's clone and asks the thread to rebase (or merge), resolve the conflicts, run the tests and
  push, or to say which conflict needs a person. At most twice per conflict; then it asks whoever wanted the change
  to look. Merging cleanly again starts the count over.
- **Not left to rot.** After `SCOUT_PR_STALE_DAYS` (default 14) with no activity, on the code host or in its thread,
  Scout asks whoever wanted it, in the thread and on the pull request, whether it's still wanted. After
  `SCOUT_PR_CLOSE_DAYS` more (default half that) still quiet, it closes it with a note; it can be reopened any time.
  Any activity starts the clock over. `SCOUT_PR_STALE_DAYS=0` turns this off.

## Reviewers, reminders and branches

- **Asking for reviews.** When Scout opens a pull request it asks for reviews from the people (and teams) its
  repository's CODEOWNERS names for the files it touches (`.forgejo/`, `.gitea/`, `.github/`, the root or `docs/`;
  the last matching rule wins), or, without one, the two people who changed those files most lately (commit emails
  looked up in the directory), plus whoever asked for the change; never itself, and at most three people. The
  "Opened" line in the thread says who (`src/owners.ts`).
- **Reminding reviewers.** On working days between 9:00 and 17:00, each channel gets at most one message listing
  pull requests in its repositories, anyone's, that have waited on a requested review for `SCOUT_REVIEW_NUDGE_DAYS`
  (default 3; 0 turns it off). Reviewers are mentioned in Slack where the people file links their login, by login
  otherwise. Drafts and pull requests nobody's been asked to review aren't listed.
- **Deleting its branches.** When one of Scout's pull requests is merged, its `scout/…` branch is deleted, unless
  another open pull request still comes from it. A closed one keeps its branch for `SCOUT_CLOSED_BRANCH_DAYS`
  (default 30), so it can be reopened, and loses it then if it's still closed. The code host keeps the pull
  request's commits either way.

## Following up on stalled threads

When Scout's answer ends by asking people something and nobody replies for `SCOUT_THREAD_RECAP_DAYS` (default 3; 0
turns it off), Scout follows up once in that thread: where things stand, what's left, who it's waiting on (by
name), and the one question that would move it on. It doesn't redo or continue any work, and it doesn't follow up
again until someone speaks in the thread. A thread with an open pull request is left to that pull request's own
reminders (stale pull requests, reviewers). The channel's weekly summary lists threads still waiting after their
follow-up, by link, without summarizing them again (`src/recaps.ts`).

## Each channel's week

On Monday after the reflection hour, alongside the weekly report in the home channel, Scout posts a summary in every
channel it worked in the week before: threads, pull requests merged, closed and still in review, what's still open
there, threads still waiting on someone after their follow-up, what models cost against the channel's budget, and
the notes it kept, which people can still correct
(`src/weekly.ts`). A channel with nothing to report gets nothing, and each channel gets each week once.
`SCOUT_WEEKLY_SUMMARY=off` turns it off.

## Schedules

People give Scout recurring work by asking for it in a thread ("every Monday at 9, check for dependency updates").
Scout turns the time into cron (minute, hour, day of month, month, day of week, in the host's local time, like the
reflection hour), says it back in words, and keeps the schedule in `scout.sqlite` (`src/schedules.ts`).

Schedules are public to their channel. Anyone who may ask for work there can list, change, pause or remove them by
asking in any thread in that channel; schedules in other channels are out of reach. Who set each one up and who last
changed it are recorded, and every change is in the audit trail (`schedule_added`, `schedule_changed`,
`schedule_removed`, `schedule_ran`).

When a schedule is due, Scout starts a new thread in its channel whose first message names the schedule, who set it
up, and that anyone there can change or stop it. A run counts against the channel's budget and concurrency like any
request. If Scout was down at the time, it still runs within 10 minutes of it; later than that, it waits for its
next time. The dashboard lists every schedule and when it runs next.

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
  sandbox connections, and the capacity gauges (below). With `SCOUT_METRICS_TOKEN` it takes that bearer token; otherwise the dashboard's login.

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
  restarts. They're on even without a limits file: 8 runs in all and 3 per channel (`SCOUT_MAX_RUNS`,
  `SCOUT_MAX_RUNS_PER_CHANNEL`); the file's `concurrency` wins where it's set.
- **Per-run limits** stop a runaway request. Scout is told to summarize and ask before going on.

Spend comes from a ledger of every model response. Prices are pi-ai's catalog prices, unless `SCOUT_PRICES_FILE`
overrides them (dollars per million tokens):

```json
{ "anthropic/claude-opus-5-5": { "input": 5, "output": 25, "cacheRead": 0.5, "cacheWrite": 6.25 } }
```

The dashboard shows this week's spend by channel against each budget.

## Capacity: when people wait, saying so

With many threads (and approaches) working, something runs out first: Scout's runs, the model gateway, or spoond's
sandboxes. Scout holds the extra work rather than letting everything slow down at once, tells people what they're
waiting on and roughly how long, and tells whoever runs it when waiting becomes common (`src/capacity.ts`).

- **Runs**: 8 at once in all and 3 per channel by default (above). Beyond that, requests queue. 8 fits a spoond
  share of about 10 to 15 sandboxes with room for short commands; 3 per channel keeps one busy channel from
  taking every slot.
- **Model calls**: at most `SCOUT_MAX_MODEL_CALLS` in flight (default 6; 0 for no limit). Each run makes many calls
  in a row, so 8 runs rarely need 8 at once; 6 keeps the gateway out of the overload that 4 busy threads with tool
  loops caused. Waiting calls go in order, and the run's status line says so: "Waiting my turn for the model: it's
  busy with other threads, 2 ahead of me."
- **Sandboxes**: when spoond is full (429 or 503), Scout keeps asking for up to `SCOUT_SANDBOX_PATIENCE` seconds
  (default 1800, at least 60) and says so in the status line: "Waiting for a workspace: the sandbox host is full
  right now (3 minutes so far)." If it gives up, it says why in plain words and what would help.
- **ETAs** come from what Scout measured: how long recent runs took and how long recent waits lasted (kept 30 days in
  `scout.sqlite`). They're ranges ("My guess: about 3–10 minutes"), from the quicker to the slower quartile, and
  there's no guess until there are at least three runs to go on. A queued request's placeholder says where it is in
  line and the guess; the status lines of waiting runs say the usual wait for the model or a sandbox.
- **When waiting becomes common**, Scout posts in its home channel at most once a day, with the numbers and what
  would help (raise `SCOUT_MAX_RUNS` or a channel's limit, give the gateway more room, a bigger share on spoond):
  when over a fifth of the day's requests waited over a minute, model waits were long (p90 over 30 s), sandboxes
  ran out, or waiting doubled from the week before. Only with team initiative (`SCOUT_INITIATIVE=team`).
- **The model's start**: every model call's time from being sent to its first token is kept too. That's the gateway
  queueing and the model starting up, which Scout can't shorten, but it's often much of a run. When the slowest tenth
  of the day's calls took over 30 s, or the median doubled on the week before (and is over 10 s), the same daily
  notice says so, and that it's the gateway or its provider, not Scout.
- **Each Monday** the weekly report adds a line on last week's waits, and the nightly reflection gets the same line,
  so it can propose working differently when its own long runs are why people waited.
- **Gauges** on `/metrics`: `scout_runs_queued`, `scout_model_calls_in_flight`, `scout_model_calls_waiting`,
  `scout_sandboxes_open`, `scout_sandboxes_waiting`, `scout_progress_edits_waiting`, `scout_event_loop_lag_ms` and
  `_p99_ms`, `scout_wait_{run,model,sandbox}_p50_seconds` / `_p90_seconds`, and
  `scout_model_first_token_p50_seconds` / `_p90_seconds` over the last day. The dashboard's
  "capacity" panel shows the same.

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
