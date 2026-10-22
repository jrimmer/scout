# Changelog

Scout follows [semantic versioning](https://semver.org). The public interface is:
- the settings in `.env.example`;
- the profile's layout and frontmatter;
- the Slack manifest;
- the repositories file;
- the code host and sandbox drivers' configuration.

A change to any of these that needs people to act is a major version. Everything else is minor or a patch.

## Unreleased

### Added
- **Scout says when its data isn't backed up off the machine** (`docs/operations.md#backups`). It looks for Litestream's directory beside `pi.sqlite` and `scout.sqlite` (`.pi.sqlite-litestream`) and fails a database with a change Litestream hasn't copied for 15 minutes. While either isn't backed up:
  - the doctor fails a "Backups" check;
  - the dashboard keeps a red line under its top one, `/status.json` has `backup`, and `/metrics` has `scout_backup_ok` at 0;
  - the home channel hears once a start, 20 minutes in, and in the Monday report while it's still true.

  `SCOUT_BACKUP=none` says it's on purpose, for test and throwaway installs: a warning, a dimmed line, and nothing in Slack.
- **The doctor checks the service's restart policy:** under systemd, it warns unless the unit has `Restart=always`, which a drain for a deploy needs.
- **Pi Durable's traces in the OTLP export** (`SCOUT_OTLP_ENDPOINT`): submissions, task phases and model requests (`pi.durable.*`, `pi.ai.request`), through the same exporter. `pi.ai.request` replaces Scout's own `scout.model_call`; the run's spend moves to `scout.cost_usd` on `scout.run` (`docs/operations.md`).
- **Fallback models** (`SCOUT_FALLBACK_MODELS`, off unless set; `docs/operations.md`). After `SCOUT_FALLBACK_AFTER` failed calls in a row (default 3), a model's calls go to the first fallback that's answering, and the thread carries on instead of failing. After `SCOUT_FALLBACK_FOR` minutes (default 15), one call tries the model again. The thread says it's on the fallback, the home channel hears when a model goes down and when it's back, spend is the fallback's, and the dashboard, `/status.json` and `/metrics` show which model is answering.
- **Deploys without waiting for a quiet moment** (`npm run deploy`, `docs/operations.md`). **Update your systemd unit from `deploy/scout.service` first:** `Restart=always`, and the deploy lock (see Changed).
  - `kill -INT` drains Scout for a restart: no new model calls start, the model calls and tool calls running finish, and Scout stops cleanly. systemd starts it again, and each run carries on from the step it stopped at. Messages that arrive meanwhile run after the restart.
  - It waits at most `SCOUT_DRAIN_MAX` seconds (10 minutes), then stops anyway. The dashboard says it's draining, and a thread waiting on its next step says Scout is restarting.
  - `scripts/deploy.sh` fetches and refuses a commit CI hasn't passed on the code host. It also refuses one that moves Pi Durable to another version until `pi.sqlite` is backed up. Otherwise it drains, waits for Scout to stop, fast-forwards, runs `npm ci` if the lockfile changed, and waits for the new Scout's `/healthz`.
- **Sandboxes:**
  - While a command runs, Scout checks every minute that the sandbox still answers. After five minutes without an answer it stops waiting and says the sandbox has probably crashed. Until now, a thread could wait silently for up to a day.
  - Scout reads spoond's own report of a command that never started (spoond 3.12.1), as well as checking for itself.
- **The doctor checks the running Scout:**
  - that it answers;
  - problems lasting an hour;
  - long runs;
  - long waits for a turn;
  - a model slow to start answering;
  - sandboxes waiting for room;
  - event-loop lag.

  It reads the dashboard's snapshot (`/status.json`, with `SCOUT_METRICS_TOKEN`). Slowness is a warning, with where it comes from. Only Scout not answering, or a problem lasting an hour, fails. So a scheduled `npm run doctor` works as a monitor.
- **A nightly benchmark** of models on Scout's own work (`docs/evals.md`), off unless `SCOUT_BENCH_MODELS` names models. Replayed fixes judged by their own hidden tests and by the rest of the tests still passing, as in SWE-bench, and bugs to locate; each night every model runs the same 7 tasks from the pool, the ones run longest ago. Two radar charts on a new Benchmark page, linked from the foot of the dashboard: what each model can do (coding, finding bugs, tool use, no regressions, cost), on fixed scales, and what it's like to work with (first tokens, output speed, task time, retries), as measurements charted against each other, over each model's last 10 nights.
- **A repository can ask for bigger sandboxes** (`"size"` in the repositories file), for builds that need more memory than the default, its image builds included.
- **Evals** can replay a commit: files given at the start, tests hidden until after the work, and tasks that ask where a bug is.
- **Monitoring:** `docs/operations.md` recommends how to monitor Scout with the tools you already have: `/healthz`, a scheduled doctor, and alerts on `/metrics`.
- **Tests at the edges:**
  - `src/slack.ts` against recorded Socket Mode payloads and a stand-in Slack Web API, covering every handler;
  - an end-to-end test from a Slack mention to a pull request on a stand-in Forgejo.
- **Continuous integration:** on every pull request, merged with the latest `main`, and on `main` after every push, on Scout's own runner (`.forgejo/workflows/ci.yml`): type checks, the full test suite, and the Docker sandbox tests. It reports; it doesn't block merges. Jobs start from the snapshot Scout's own sandboxes start from (`scout/node24`).
- **Repository images in CI:** with spoond 3.13.0's runner, a repository's CI jobs can start from the image Scout builds from its `.scout/setup.sh` (`docs/operations.md`).
- **Releases:** this changelog, and the release checklist in `docs/releasing.md`.
- **Settings:** `.env.example` now lists every setting Scout reads, and a test keeps it so. `SCOUT_GATEWAY_OPENAI_API` was missing.

### Changed
- **Pi Durable 1.4.0** (from 1.3.0). Model retries now wait without holding a process, so a restart during one loses nothing, and a task that keeps crashing is parked instead of looping. **Upgrading converts `pi.sqlite` for good:** 1.3.0 can't open it afterwards, so back it up first.
- **The MCP SDK is 1.32.1** (from 1.31.0), for four security advisories, among them headers re-sent across origins on a redirect.
- **Deploys change nothing under a draining Scout.** `scripts/deploy.sh` used to fast-forward and run `npm ci` before the drain, so the old Scout, still finishing its steps, could load new code or a half-installed `node_modules`. It now takes a lock, drains, waits for Scout to stop, updates, and only then lets go of the lock. If the update fails, it puts the checkout back first, so Scout starts on what it ran before. **Add to your unit**, under `[Service]`, then `systemctl daemon-reload` (the deploy script refuses a unit without the first line, and prints it with your install directory):
  ```ini
  ExecStartPre=/usr/bin/flock /opt/scout/.deploy.lock true
  TimeoutStartSec=15min
  ```
- **Litestream runs as its own service**, not wrapped around Scout (`docs/operations.md#backups`). `deploy/scout.service` now runs `node src/main.ts` directly, so every signal reaches Scout and `KillMode=mixed` is gone. Litestream is the packaged `litestream.service` with the drop-in `deploy/litestream.service.d/scout.conf` (Scout's user, credentials from `/etc/litestream.env`). `deploy/litestream.yml` is now Litestream 0.5's format: the old one put `retention` under each replica, which 0.5 ignores, so old backups were never pruned; retention is now global, a snapshot a day kept for a week. The unit still restores both databases on a new host before Scout starts. **If your unit runs `litestream replicate -exec`:**
  - copy `deploy/litestream.yml` to `/etc/litestream.yml` and fill in your replica;
  - install the drop-in and `/etc/litestream.env`, then `systemctl enable --now litestream`;
  - update Scout's unit from `deploy/scout.service`: `ExecStart=/usr/bin/node src/main.ts`, no `KillMode=mixed`, and the restores reading `-config /etc/litestream.yml` and the keys from `/etc/litestream.env` (mode 640, Scout's group), which Scout's own environment no longer gets.

### Fixed
- **Profile repository:** with `SCOUT_PROFILE_REPO_URL` set and no `SCOUT_PROFILE_DIR`, Scout refused to start because the default, the example `profile/`, isn't a clone, while the doctor said OK. Scout now clones the profile into `data/profile`, and the doctor fails a profile directory that holds something else.
- **`npm run job`:** with a model that wouldn't answer (a wrong key, an unknown model) it exited 1 without a word. It now says why.
- **The doctor, on repositories:** it showed only the first line of what git said. It now shows the cause ("Host key verification failed", "Permission denied (publickey)") with a hint for it.
- **The doctor, on the model:** it never tried the model. It now asks for a few tokens through the gateway Scout uses, and fails on a refused key or an unknown model, with how to fix it.
- **Setting up from scratch:** `docs/setup.md` now covers what a new machine needs: Node 24, a user for Scout in the `docker` group, its SSH key and the code host's host key, `.env` permissions and a systemd unit. `.env.example` no longer says to clone the profile yourself. Found by an install on a fresh Debian container.
- **Stopping and signals under systemd:** under the old unit, Litestream wrapped Scout and passed on only SIGINT and SIGTERM, so `kill -USR2` (reflect now) and `kill -HUP` (read secrets again) went to Litestream, SIGHUP stopped it, and `systemctl stop` could reach Scout twice and stop it at once instead of cleanly (which Pi Durable 1.4.0 counts towards parking a run as crash-looping). With Litestream as its own service (see Changed), Scout is the unit's main process and gets each signal once.
- **spoond restarts:** a running command no longer fails when spoond restarts or the network hiccups. Scout keeps following it for two minutes, then stops and says it may still be running.
- **Ask Scout form:** when Slack was slow to say where the form was sent, the form failed after Slack's three seconds and no thread started. Scout now remembers channels it can work in, gives Slack two seconds, and otherwise takes the form and checks afterwards, telling the person privately if it can't work there.
- **Slack outages:** Slack's client tried a failed call again for about half an hour while the thread sat silent. It now tries for five minutes. A final answer Slack still won't take is tried again every two minutes for up to six hours, and after a restart the thread still gets it.
- **Docker sandboxes:** the sandbox's user couldn't write its own `/work`, so every Docker sandbox failed at its first file write. Docker gave the empty volume root's ownership each time a container mounted it. Found by the Docker tests' first run.

## Before 1.0 (2026-10-19 to 2026-10-21)

Everything Scout did before its first release, built over its first three days. Grouped by area:

### Working in Slack
- **Requests:** Scout answers mentions in public channels, and nowhere else; DMs and private channels get a polite no.
- **Steering a run:** a run can be steered while it works, stopped with 🛑 or "@Scout stop", and continued.
- **One message per run:**
  - it keeps saying what Scout is doing;
  - the request's reaction follows along;
  - a resumed run keeps its message.
- **Slack's own features:**
  - the /scout command and the Ask Scout shortcut;
  - link previews for the code host;
  - a canvas per channel;
  - the list of Scout's work;
  - a Workflow Builder step.

  Scout adapts to what the workspace's plan allows.
- **Costs:** each answer says what it cost against the week's budget. A weekly report covers the costs of models.
- **Follow-ups:** Scout follows up once on a thread that stalled waiting on people, and posts each channel's week.

### Working on code
- **Sandboxes:** each thread works in its own sandbox, through swappable drivers (Docker, spoond, local).
  - A connection is held only while a tool runs.
  - Quiet sandboxes sleep after 15 minutes.
- **spoond:**
  - its REST transport holds no connection;
  - snapshots per repository;
  - leases named for their thread;
  - Scout stops waiting for a command spoond lost before it started.
- **Repositories:** each channel works in its own repository or repositories, starting in its zones. A repository can have its own image, built from its setup script.
- **Self-review:** each change is reviewed before people are asked to look. Scout never pushes over a teammate's commits.
- **Pull requests:** Scout says in the channel which pull request came of a thread, and asks the right reviewers (CODEOWNERS, or recent authors).
  - It reminds reviewers and cleans up branches.
  - It watches CI on its pull requests and fixes red builds.
- **Pull request reviewer:** asked like a person, with fixes made from the Slack thread.
- **Searching:** Scout searches its earlier threads, and every repository's code from any thread.
- **Egress:** a sandbox that can't reach a host asks for it.
- **Approaches (experimental):** Scout tries several at once and lets people choose.

### Beyond Slack
- **The code host:** work taken from Forgejo or GitHub, with one thread per pull request.
- **The alert responder:** a public investigation per alert, for Gatus and Grafana. A flapping alert stays in its thread.
- **Schedules:** recurring work, public to the channel.
- **MCP servers:** for tools beyond code (Forgejo CI, Gatus, Grafana). Changes go through code by default, or through approval.
- **Automation:** job modes, and `npm run job` for a single task without Slack.

### Learning
- **Memory:** learns, un-learns, and keeps unreviewed notes on a short leash.
- **The nightly reflection:** proposes profile changes as a pull request, and revises it from review. It learns from what reviewers say, not just from whether they merge.

### Running Scout
- **Governance:**
  - an audit log;
  - budgets;
  - roles from the identity provider;
  - who may ask, by group;
  - one approval per change, given with a 👍;
  - secrets handling;
  - telemetry.
- **The initiative dial:** how much Scout does on its own.
- **Capacity:** limits on concurrent runs and model calls, with Scout saying when it waits. It times the model's first token and says when the model is slow to start.
- **The model gateway:** models only the gateway knows (`gateway/<name>`), with a warning when one has no price.
- **Observability:**
  - a live, read-only dashboard;
  - `/metrics`;
  - `npm run doctor`, which checks everything Scout depends on and says how to fix it.
- **Evals:** test Scout's changes before they ship, with where a run's time goes.
- **License:** BSD 3-Clause.
