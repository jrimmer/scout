# Setting Scout up

From nothing to Scout answering in a Slack channel. Each step says what it's for; `.env.example` lists every
setting, and [operations.md](operations.md) explains what each feature does once it's running.

## 1. What you need

- A machine to run it on, always on: Node 24+, git, curl and sudo (a minimal Debian image has neither curl nor sudo:
  `apt-get install -y sudo curl git`), and (for the default sandboxes) Docker. A small VM or container
  is plenty (2 cores, 4 GB, 16 GB of disk); the work itself happens in sandboxes.
  - Node: distributions often ship an older one (Debian 12 has 18). Take 24 from NodeSource
    (`curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs`) or the
    tarball at [nodejs.org](https://nodejs.org/en/download). `node -v` should say 24 or later.
  - Docker: Docker's own packages ([docs.docker.com/engine/install](https://docs.docker.com/engine/install/)). In a
    Proxmox LXC container, turn on `nesting`.
- A Slack workspace where you can install apps. Some features need a paid plan (Lists, custom workflow steps);
  Scout finds out what yours allows and says so at start.
- A code host: Forgejo (or Gitea), or GitHub.
- A model: an Anthropic or OpenAI key, or a model gateway (Bifrost, LiteLLM) in front of them.

Scout runs as a user of its own, which can use Docker. Make it, then do the rest as that user, so the checkout,
`.env` and Scout's SSH key are its own:

```bash
sudo useradd -m -s /bin/bash -G docker scout
sudo -iu scout
git clone <this repository> scout && cd scout   # a read-only clone; it needs no account
npm ci                                          # its deprecation and install-scripts warnings don't stop anything
cp .env.example .env && chmod 600 .env          # .env will hold secrets
```

## 2. The Slack app

1. At api.slack.com/apps, **Create New App → From a manifest**, pick your workspace, and paste
   `slack-manifest.yaml`. Before you do, change `unfurl_domains` to your code host's domain, so links to pull
   requests get previews.
2. **Basic Information → App-Level Tokens**: generate one with `connections:write`. That's `SLACK_APP_TOKEN`
   (Scout uses Socket Mode, so it needs no public address).
3. **Install App**: install it, and copy the Bot User OAuth Token into `SLACK_BOT_TOKEN`.
4. Invite Scout (`/invite @Scout`) to the public channels where it should work, and to its home channel (step 7).
   It only ever works in public channels.

When you change the manifest later (a new Scout version may add scopes), paste it again and reinstall; the bot token
usually stays the same.

## 3. The code host account

Give Scout its own account, so its pull requests are its own and you can revoke it without touching yours.

- Add it as a collaborator (write access) on the repositories it works in, and on its profile repository (step 7).
- An SSH key for it, on that account: the host clones and pushes with it, so repository URLs are `ssh://` ones.
  Sandboxes never get it. Make it on Scout's machine, as Scout's user, and trust the code host's SSH host key once
  (Scout never answers ssh's "are you sure?", so without this every clone fails with "Host key verification
  failed"):

  ```bash
  ssh-keygen -t ed25519 -N "" -C scout -f ~/.ssh/scout_ed25519   # add ~/.ssh/scout_ed25519.pub to Scout's account
  ssh-keyscan <code host> >> ~/.ssh/known_hosts                   # check the fingerprint against your code host's
  ```

  Then set `SCOUT_GIT_SSH_KEY=~/.ssh/scout_ed25519` in `.env`. The doctor (step 10) says which of these is missing.
- An API token for it (`SCOUT_CODEHOST_TOKEN`):
  - **Forgejo/Gitea**: `write:issue`, `write:repository`, `read:user` and `write:notification` (the last for work
    asked of Scout on the code host). `SCOUT_CODEHOST=forgejo`, `SCOUT_CODEHOST_API=https://<host>/api/v1`.
  - **GitHub**: a classic token with `repo` and `notifications`, `SCOUT_CODEHOST=github`.

## 4. Repositories

The default repository is `SCOUT_REPO_URL` and `SCOUT_REPO_SLUG` (`owner/name`). More go in a JSON file named by
`SCOUT_REPOS_FILE`:

```json
[{ "name": "web", "gitUrl": "ssh://git@git.example.com/acme/web.git", "slug": "acme/web", "base": "main",
   "egress": ["registry.npmjs.org"] }]
```

A repository whose build needs more memory than `SCOUT_SANDBOX_SIZE` gives can ask for bigger sandboxes with
`"size"` (spoond: `small`, `medium`, `large` or `xlarge`; Docker: a memory limit like `"8g"`).

Each channel says which repository it works in, in the frontmatter of its profile's
`channels/<channel>/instructions.md` (`repo: web`; see `profile/channels/README.md`). A channel that doesn't say works
in the default repository.

## 5. Sandboxes

Every thread works in its own sandbox: its own clone, no credentials.

- **docker** (the default): add your repositories' toolchains to `sandbox/Dockerfile`, then build the image once
  with `docker build -t scout-sandbox:latest sandbox` (a few minutes). Network is off unless
  `SCOUT_SANDBOX_NETWORK=open`, so installs and downloads in a sandbox fail until you open it; Docker can't limit it
  to a list of hosts.
- **spoond**: microVMs with per-repository egress allowlists, snapshots and suspend/resume.
  `SCOUT_SANDBOX_DRIVER=spoond`, `SCOUT_SPOOND_URL`, `SCOUT_SPOOND_TOKEN`, and `SCOUT_SPOOND_TRANSPORT=rest` on
  spoond 3.11+.
- **local**: no isolation at all; for tests and trying things on a laptop only.

## 6. The model

`SCOUT_MODEL=anthropic/claude-opus-5-5` with `ANTHROPIC_API_KEY` (or an OpenAI model with `OPENAI_API_KEY`). Through
a gateway: `SCOUT_GATEWAY_URL` and `SCOUT_GATEWAY_KEY`, and `SCOUT_MODEL=gateway/<name>` for models only the gateway
knows. Set `SCOUT_PRICES_FILE` for models the built-in prices don't cover, so budgets count them.

## 7. The profile

What Scout knows lives in files: a system prompt, skills, per-channel instructions. `profile/` here is a starter,
and without the settings below Scout uses it as it is, with no nightly proposals.

For the learning loop, push the starter to a new, empty repository on the code host (here `team/scout-profile`):

```bash
git config --global user.name Scout && git config --global user.email scout@example.com   # once, if Scout's user has none
cp -r profile ~/scout-profile && cd ~/scout-profile
git init -b main && git add . && git commit -m "Scout's profile"
git push ssh://git@<code host>/team/scout-profile.git main
```

Then set `SCOUT_PROFILE_REPO_URL` (that URL) and `SCOUT_PROFILE_REPO_SLUG` (`team/scout-profile`). Scout clones it
at its first start, into `data/profile` unless `SCOUT_PROFILE_DIR` names another path; that path must not exist yet
(or already be the clone), and `profile/` here isn't one. Scout keeps it pulled, and every night proposes changes to
it as a pull request. Protect its main branch so Scout can only propose.

Set `SCOUT_REFLECT_CHANNEL` to Scout's home channel: where it posts its proposals, weekly reports and requests to
whoever runs it.

## 8. Who may ask

By default anyone in a channel Scout is in may ask it for work. To narrow it, see "Who may ask for work" in
[operations.md](operations.md): the code host's own permissions (`SCOUT_REQUESTER_CHECK=enforce`), or groups from your
identity provider (`SCOUT_DIRECTORY`, `SCOUT_ROLES_FILE`), which also decide who may approve changes made through
tools and network access for sandboxes. Set budgets (`SCOUT_LIMITS_FILE`) before you open it up widely.

## 9. How much Scout does on its own

Scout always does what people ask. How much it does **on its own initiative** is one setting, `SCOUT_INITIATIVE`,
with three positions. Scout says which it's on in its log at every start, and in its home channel the first time.

| `SCOUT_INITIATIVE` | Scout… |
|---|---|
| `asked` | only does what people ask for: mentions, replies, the code host, reactions, the shortcut, `/scout`, workflows, and schedules people set up |
| `own` | also looks after its own work: fixes CI on its pull requests, keeps them mergeable, asks about quiet ones and closes them, deletes its branches, follows up on its stalled threads, builds its sandbox images, asks reviewers for its pull requests, and runs the nightly reflection on its own profile |
| `team` (default) | also acts on the team's work: watches and investigates alerts, reminds reviewers of anyone's pull requests, posts the weekly report and channel summaries, keeps channel canvases and the list of its work, previews code host links |

The dial is a ceiling: each feature also has its own setting (`SCOUT_PR_STALE_DAYS`, `SCOUT_REVIEW_NUDGE_DAYS`,
`SCOUT_WEEKLY_SUMMARY` and so on), and `team` doesn't switch on anything you've turned off. Start with `own` if
you'd rather get to know Scout before it acts on the team's work.

## 10. Check, then run

```bash
npm run doctor   # Slack, the code host, repositories, the model and the rest: ✅, ⚠️ or ❌, with how to fix it; exits 1 if anything is broken
npm start
```

Before the first `npm start`, the doctor's last check ("Running") fails, because there's no Scout yet to ask, and so
does "Backups", because there are no databases yet. Run it again once Scout is up.

It asks the model for one short answer (a few tokens), and says what git said about a repository it can't reach.
With Docker it doesn't check that Docker answers or that the sandbox image exists: `docker image ls scout-sandbox`
should list it.

Mention `@Scout` in one of its channels. Its startup log says which Slack features are on and why the rest aren't.
In Slack, `/scout doctor` runs the same checks. [operations.md](operations.md#monitoring) says how to monitor Scout once it runs.

To run it as a service, a unit named `scout` (the doctor's hints say `systemctl status scout`) is enough, in
`/etc/systemd/system/scout.service`:

```ini
[Unit]
Description=Scout
After=network-online.target docker.service

[Service]
User=scout
WorkingDirectory=/home/scout/scout
ExecStart=/usr/bin/node --env-file=.env src/main.ts
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`sudo systemctl enable --now scout`, then `journalctl -u scout -f` for its log. Keep `Restart=always`: deploys
drain Scout and count on systemd to start it again, and the doctor warns without it.

That unit has no backups: if the box goes, every thread goes with it, and Scout says so (the doctor fails, the
dashboard shows a red line, and its home channel hears about it). `deploy/scout.service` is the same with Litestream
backups around it; use it anywhere people rely on Scout ([operations.md](operations.md#backups)). For a test install,
`SCOUT_BACKUP=none` says no backups is on purpose. [operations.md](operations.md) also covers secrets, telemetry and
the dashboard.

## 11. Keeping it up to date

`npm run deploy` on the server: it checks CI passed, updates, and restarts Scout once the steps running have finished
([operations.md](operations.md#deploying)). By hand: `git pull`, `npm ci`, and `kill -INT` Scout's process with a
service manager that starts it again. Paste the Slack manifest again if it changed.
