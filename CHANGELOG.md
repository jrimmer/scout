# Changelog

Scout follows [semantic versioning](https://semver.org). The public interface is:
- the settings in `.env.example`;
- the profile's layout and frontmatter;
- the Slack manifest;
- the repositories file;
- the code host and sandbox drivers' configuration.

A change to any of these that needs people to act is a major version. Everything else is minor or a patch.

## Unreleased

### Changed
- **The benchmark runs on the team's own work, not Scout's.** Its tasks come from the repositories of the team Scout
  is deployed with, so they're private: they live with the install (the data directory's `bench/`, or
  `SCOUT_BENCH_TASKS`), and the tasks from Scout's own history are gone. With no tasks yet, a night runs nothing and
  the Benchmark page says so. The page's note says where the tasks come from and now spans the page's full width.

### Fixed
- **A request's reaction shows Scout's steps again behind a slow model.** A phase showed only once it had lasted 1.5 s.
  When the model takes many seconds to start answering, a run is long thinking with quick reads and edits between, so
  the reaction sat on 🧠 the whole run. Steps now show even when they were over in a moment, each for at least 3 s;
  thinking still waits 1.5 s, so quick turns between steps don't flicker.

## 1.0.1 (2026-10-22)

Nothing to do when upgrading from 1.0.0.

### Changed
- **The self-review is quicker.** It read files one round at a time until it chose to answer: two to six model calls in production, often re-reading a file the diff already showed. Behind a gateway whose first tokens are slow, each call is a wait, and the self-review took 45% of an eval run's time. Now the reviewer asks for every file it needs in one round, then answers with no more tools: two model calls (one if the diff is enough). Its verdict and findings work as before. A diff too big to show whole (over 60,000 characters) is reviewed as before, reading as long as it needs. The credential scan is unchanged.

### Tests
- **Fake credentials in tests are built at run time,** so secret scanners (GitHub's push protection among them) don't
  mistake them for real ones.

## 1.0.0 (2026-10-22)

Scout's first release: installable and runnable by people who didn't build it, with an end-to-end test suite and a
security review behind it.

### Upgrading from an earlier build

Do these before or as you deploy 1.0.0:
- **Slack app:** paste `slack-manifest.yaml` into the app's settings again and reinstall. The Ask Scout workflow step
  now acts as whoever ran the workflow: reopen and publish any workflow that uses it, and start it as a person.
- **Who may ask is checked by default** (`SCOUT_REQUESTER_CHECK=enforce`). Map people to code host logins
  (`SCOUT_PEOPLE_FILE` or `SCOUT_DIRECTORY`) or name groups in `SCOUT_ROLES_FILE` (`request`); `off` must now be set
  on purpose, and any value other than `off`, `warn` or `enforce` stops Scout at start. On GitHub, list each person in
  the people file (`SCOUT_CODEHOST_LOGINS=separate`).
- **Network approvals need named approvers:** add `"approve": { "egress": ["<group>"] }` to the roles file, or nobody
  can allow a sandbox a new host from Slack. `*` doesn't cover it.
- **The systemd unit:** take `deploy/scout.service`'s `Restart=always`, the deploy lock (`ExecStartPre=/usr/bin/flock
  <install dir>/.deploy.lock true`, `TimeoutStartSec=15min`), and run Litestream as its own service
  (`deploy/litestream.yml`, `deploy/litestream.service.d/scout.conf`, `/etc/litestream.env`). Then deploy with
  `npm run deploy`.
- **Pi Durable 1.4.0 converts `pi.sqlite` for good:** back it up first; an earlier build can't open it afterwards.
- **Your profile's `system.md`:** add the lines on the `<@ID> (name): text` message format and "context only" messages
  from `profile/system.md`.
- **Monitors reading `/status.json` with the metrics token** get a reduced view now; the full snapshot needs the
  dashboard login. Scout's reviews of other people's pull requests are comments, never approvals, so they no longer
  count towards required approvals.
- **Schedules** run as their owner: ones recorded as set up by Scout itself pause when next due, until someone who may
  ask in that channel resumes them.


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
- **Breaking: who may ask is checked by default** (`SCOUT_REQUESTER_CHECK=enforce`; `docs/setup.md`, step 8). A fresh install must say who may ask: map people to code host logins (`SCOUT_PEOPLE_FILE`, or `SCOUT_DIRECTORY`) so the code host's permissions decide, or name groups in `SCOUT_ROLES_FILE`'s `request`. Until then Scout tells everyone it doesn't know their account. **An install that relied on the old default must set one of these, or `SCOUT_REQUESTER_CHECK=off` on purpose.**
  - The setting takes `off`, `warn` or `enforce` (any case) and stops Scout at start on anything else. It used to read any value but exactly `enforce` (`Enforce`, `on`, `true`) as off. `warn` lets everyone in and logs whom `enforce` would refuse.
  - The roles file's `request` groups and `SCOUT_ALLOWED_USERGROUP` now apply whatever the mode; before, both did nothing unless the check was `enforce`.
  - Scout warns at every start when the check isn't `enforce`. The doctor warns too, and fails when a repository the roles file doesn't narrow is public on the code host.
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
- **Stopping right after an answer:** an answer to someone on the code host could miss being copied back to the issue or pull request if Scout stopped (a drain for a deploy, or a SIGTERM) just after it. Stopping now waits for that copy, for at most half a minute.
- **Reflection:** the day after a proposal, a quiet day still started a reflection, about nothing but Scout's own announcement of the last one. Its announcement thread no longer counts as new activity.
- **Approve buttons:** someone who isn't among a change's approvers could press Approve and see "Approved by" them, though the change was then refused. The button now checks the approvers for the waiting change first and says who can.
- **Queue notice:** "I'm working on 1 things already" now reads "1 thing".
- **Starting with a token Slack refuses:** `npm start` crashed with a stack trace. It now says which token was refused (`SLACK_BOT_TOKEN` or `SLACK_APP_TOKEN`) and to run `npm run doctor`, and exits 1. A setting Scout already words an error for (a missing or malformed one in `.env`) prints just that message too; a real bug keeps its stack.
- **`npm run job` with a repository it can't reach:** it printed the whole stack of the failed `git clone` before "Scout couldn't finish". It now prints that line alone, with git's own words in it.
- **The doctor, on a server it can't reach:** "can't reach <address> (fetch failed)" now has a hint from the cause: nothing listening at that port, a host name that doesn't resolve, https against a server that serves http (or the reverse), an untrusted certificate, a timeout.
- **The doctor, on restarts:** it also warns when the systemd unit doesn't wait for the deploy lock (`ExecStartPre=/usr/bin/flock <install dir>/.deploy.lock true`), with the lines to add, as `npm run deploy` does when it refuses.
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

### Security
- **Anyone could make Scout work with the shipped settings**, on a public repository anyone on the code host. The requester check is now on by default (see Changed).
- **GitHub logins were taken for directory usernames:** with roles, a stranger who registered the GitHub login `admin` got the directory's `admin`'s groups. On GitHub a login is now a person only through the people file (`SCOUT_CODEHOST_LOGINS=separate`, GitHub's default); Forgejo keeps matching logins to directory usernames, which assumes it signs people in through the directory (`directory`, its default; set `separate` if it doesn't). A directory username is no longer taken for a GitHub login when checking a Slack user's access or asking for reviews either.
- **Requests on the code host checked only the last asker:** a stranger's `@scout` rode along with a maintainer's comment read in the same look. Everyone asking is now checked, and whoever may not is kept as context and told why. An issue assigned to Scout was checked as its author's request; it's now checked as whoever assigned it, from the issue's history.
- **Code search read every repository from any thread:** someone admitted on a public repository could have Scout read a private one with `read_code`. It now reads only the thread's own repository and those the person asking may ask for work in.
- **`/scout`:** `doctor` answered anyone in the workspace (internal addresses, accounts, what's broken, and a model call each time); it now answers only admins, the groups the roles file lets approve everything (`approve` `*`). `status`, `waiting`, `schedules` and `ask` answer only people who may ask for work in the channel's repository. `ask` started work in private channels and DMs, putting their content in threads and search; it now works only in public channels Scout is in.
- **Files shared in Slack:** Scout sent its bot token to whatever URL a shared file named, and a remote file's can point anywhere. The token now goes only to `https://files.slack.com`, redirects included, and anything else isn't fetched at all. What Scout reads is capped by the bytes that arrive, not by the size the event claims.
- **The dashboard could be crashed:** a request for `/static/constructor` (or `__proto__`, `toString`) ended the whole Scout process. Those are 404s now, and a dashboard request that fails answers 500 instead of taking Scout down.
- **Dashboard logins:** each request ran scrypt on Scout's event loop, so a flood of wrong passwords stalled Slack and every run. Logins are now checked off the event loop, one at a time (others get a 429), and the last login that passed is remembered, so a logged-in browser doesn't pay for scrypt per request.
- **DNS rebinding:** a dashboard on loopback with no login answered any `Host`, so a web page could read `/status.json` by pointing its own name at 127.0.0.1. It now answers only `localhost`, `127.0.0.1` and `[::1]` (403 otherwise; `/healthz` still answers anyone).
- **Live views:** `/stream` takes at most 20 viewers at once (503 after that), and a viewer that stops reading is let go instead of its updates piling up in Scout's memory.
- **The metrics token's reach:** `SCOUT_METRICS_TOKEN` read the whole `/status.json`, notes, schedules and each run's last step included. With the token it now returns only what the doctor and monitors check (uptime, what's working, capacity, backups, which model is answering, problems with credentials redacted); the whole snapshot takes the dashboard's login. **A monitor that read other fields of `/status.json` with the token needs the login now.**
- **The CI tools for MCP (`mcp/forgejo-ci.ts`):** a repository named like `../admin` reached API paths outside `/repos/`. Owner and name are now each checked on their own, and `.` and `..` refused.
- **Errors in threads:** a model's or provider's error text is redacted for credentials before Scout posts it.
- **Scout's review no longer counts towards required approvals.** A pull request review from Scout was a real approval (or request for changes), which branch protection counts from an account with write access, and a pull request's own text could talk the reviewer into one. Scout's reviews are now always comments, with the verdict in the first line ("Looks good to me." or "I'd change these before merging."); its Slack summary says "found nothing blocking in" instead of "approved". **A repository that relied on Scout's approval to merge needs a person's now.**
- **Credentials in a push:** `open_pull_request` checked only the net diff, cut at 60 KB, for credentials. A token in a commit a later one removed, in a commit message, past the first 60 KB, in a binary file, or base64-encoded was pushed anyway. The host now scans everything the push carries: every new commit and its message, all added lines however big, binary files, base64 that decodes to a credential, and the pull request's title and description. It refuses the push naming the commit, the file and the kind of credential, never the value. `docs/security.md` now says this scan is the control, and the self-review only a second look.
- **The redactor knows more credentials:** Slack `xapp-`, `xoxe-` and other `xox?-` tokens, Forgejo and Gitea tokens next to a token-like name or in an `Authorization` header (a bare 40-character hex is left alone: it's a commit hash as often as not), Grafana `glsa_` and `glc_` tokens, JWTs, `Authorization: Bearer`/`Basic`/`token` values, AWS secret keys and whole private key blocks. It also redacts the exact values of the secrets Scout loaded, whatever their shape: `SCOUT_GATEWAY_KEY`, the code host and Slack tokens, the spoond, metrics and Grafana tokens, Litestream's keys, the OTLP headers and the MCP servers' `${NAME}` values. This covers the audit trail, the search index, errors in threads and in `npm run job`, and the Workflow Builder step's errors.
- **MCP results:** what an MCP tool returned went to the model as it was, credentials included. It's now redacted first.
- **Network for sandboxes needs named approvers.** Anyone could press Allow when the roles file named no `egress` approvers (no roles file, or approvers per server only), and `*` approvers counted for egress too. Now only the groups named under `"approve": { "egress": [...] }` decide, and with none named nobody can allow a host from Slack: the home channel is told that whoever runs Scout has to name them. **Installs must name egress approvers** in `SCOUT_ROLES_FILE` to keep allowing hosts from Slack, e.g. `"approve": { "*": ["admins"], "egress": ["admins"] }`.
- **What a sandbox can be allowed to reach:** `ask_for_network` took any host, including `0.0.0.0/0`, `169.254.169.254` (cloud metadata), private addresses, `metadata.google.internal` and `*.amazonaws.com`. It now refuses IP addresses and ranges (v4 and v6), `localhost` and `*.localhost`, names inside a network (`.internal`, `.local`, `.lan`, `.home.arpa`…), names that resolve to any address (`nip.io`, `sslip.io`), public suffixes, and wildcards over a public suffix or shared hosting (`*`, `*.com`, `*.co.uk`, `*.github.io`); `*.npmjs.org` still works. Allow refuses such a host left waiting from before. Resolving a public name to a private address is spoond's to stop, and it does (`docs/operations.md`).
- **The network question** named the host after the model's reason, rendered as Slack markup (so it could carry links and mentions). It now names the host first, says allowing it lets every new sandbox for the repository reach that host from now on, and shows the reason as "Scout's reason", in plain text.
- **Approvals are bound to the change asked for.** "approve" or "go ahead" counted whether or not anything was waiting, so "go ahead" to an ordinary question let the next tool write through without ever asking; an approval asked for one server was spent on another's change; and a run steered between the approval and the call could spend it on a different call. Now an approval is taken only while a change waits in Scout's answer, it covers that server, tool and arguments only, and a call that doesn't match asks again. "go ahead" and "approved" no longer approve; "approve" alone, 👍 on Scout's request, and the Approve button do. One approval, one call, 15 minutes, as before. Approvals waiting or given before the upgrade are dropped, and Scout asks again.
- **Decline:** anyone could press it and clear a waiting change, and it didn't take back an approval already given. Now only people who may approve the change can decline, a press that doesn't count is answered just to them with the buttons left in place (Approve too), and Decline takes back an approval not yet used.
- **The Ask Scout workflow step acts as whoever ran the workflow.** Its "Asked by" input let a workflow's builder name anyone, and Scout admitted, charged and audited the request as that person. The step now takes Slack's `interactivity` input (the person who ran it, which a builder can't fill in) and ignores any other. **Update the app from `slack-manifest.yaml`**, then open each workflow that uses the step, check it, and publish it again (the "Asked by" input is gone). A person now has to run such a workflow (a link, a shortcut, or a button step after a schedule or webhook); with nobody, the step fails and says why.
- **Schedules run as their owner, checked each time.** A scheduled run used to be Scout's own request, skipping the requester check, so a schedule kept working for someone who had lost access, and its task's words could take it to any of the channel's repositories. Each run is now its owner's request (whoever last changed it, or else set it up), checked in the repository its task names, audited as theirs, and their thread for follow-ups. If they may no longer ask, the schedule pauses and the channel hears why, once; someone who may ask resumes it and owns it from then on. **A schedule recorded as set up by Scout (nobody had asked in its thread, or from before) pauses the first time it's due** until someone resumes it.
- **Who said what, for the model:** each message is labelled with the speaker's Slack ID as well as their display name (`<@U0123ABC> (Ann): …`), and a message of several lines is quoted, so a display name or a line in a message can't pass for someone else. What people who may not ask for work in the repository say in a thread is marked as context only. The example profile's `system.md` says how to read this; **a profile of your own should say it too.**
- **Other apps' reactions:** reactions from bots and other apps' users counted as people's for 🛑, 🔁, 👍 and 🔍. They're ignored now.
- **Pull request reviews count against budgets and run limits**, as runs in the repository's channel, so pushes to a reviewed pull request can't spend past the channel's weekly budget. Their spend now shows under that channel.
- **The doctor warns about per-channel budgets without a total:** `weekly.perChannel` applies to every channel, and anyone can make one, so without `weekly.total` the cap multiplies.
- **Docs:** `docs/security.md` and `docs/operations.md` say the dashboard speaks plain HTTP and what to do about it off loopback (a TLS reverse proxy or a private network), and what the metrics token opens.

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
