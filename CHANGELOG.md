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
- **Monitoring:** `docs/operations.md` recommends how to monitor Scout with the tools you already have: `/healthz`, a scheduled doctor, and alerts on `/metrics`.
- **Tests at the edges:**
  - `src/slack.ts` against recorded Socket Mode payloads and a stand-in Slack Web API, covering every handler;
  - an end-to-end test from a Slack mention to a pull request on a stand-in Forgejo.
- **Continuous integration:** on every push and pull request, on Scout's own runner (`.forgejo/workflows/ci.yml`): type checks, the full test suite, and the Docker sandbox tests.
- **Releases:** this changelog, and the release checklist in `docs/releasing.md`.
- **Settings:** `.env.example` now lists every setting Scout reads, and a test keeps it so. `SCOUT_GATEWAY_OPENAI_API` was missing.

### Fixed
- **Docker sandboxes:** the sandbox's user couldn't write its own `/work`, so every Docker sandbox failed at its first file write. Docker gave the empty volume root's ownership each time a container mounted it. Found by the Docker tests' first run.

## 0.1.0 (2026-10-19 to 2026-10-21, before releases)

Everything Scout does today, built over its first three days. Grouped by area:

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
