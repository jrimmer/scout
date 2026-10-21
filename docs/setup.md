# Setting Scout up

From nothing to Scout answering in a Slack channel. Each step says what it's for; `.env.example` lists every
setting, and [operations.md](operations.md) explains what each feature does once it's running.

## 1. What you need

- A machine to run it on, always on: Node 24+, git, and (for the default sandboxes) Docker. A small VM or container
  is plenty; the work itself happens in sandboxes.
- A Slack workspace where you can install apps. Some features need a paid plan (Lists, custom workflow steps);
  Scout finds out what yours allows and says so at start.
- A code host: Forgejo (or Gitea), or GitHub.
- A model: an Anthropic or OpenAI key, or a model gateway (Bifrost, LiteLLM) in front of them.

```bash
git clone <this repository> scout && cd scout
npm ci
cp .env.example .env
```

## 2. The Slack app

1. At api.slack.com/apps, **Create New App → From a manifest**, pick your workspace, and paste
   `slack-manifest.yaml`. Before you do, change `unfurl_domains` to your code host's domain, so links to pull
   requests get previews.
2. **Basic Information → App-Level Tokens**: generate one with `connections:write`. That's `SLACK_APP_TOKEN`
   (Scout uses Socket Mode, so it needs no public address).
3. **Install App**: install it, and copy the Bot User OAuth Token into `SLACK_BOT_TOKEN`.
4. Invite Scout to the public channels where it should work. It only ever works in public channels.

When you change the manifest later (a new Scout version may add scopes), paste it again and reinstall; the bot token
usually stays the same.

## 3. The code host account

Give Scout its own account, so its pull requests are its own and you can revoke it without touching yours.

- Add it as a collaborator (write access) on the repositories it works in.
- An SSH key for it, on that account: the host clones and pushes with it (`SCOUT_GIT_SSH_KEY`). Sandboxes never get
  it.
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

Each channel says which repository it works in, in the profile (`channels/<channel>/instructions.md`,
`repo: web`).

## 5. Sandboxes

Every thread works in its own sandbox: its own clone, no credentials.

- **docker** (the default): build the image once with `docker build -t scout-sandbox:latest sandbox`. Network is off
  unless `SCOUT_SANDBOX_NETWORK=open`; Docker can't limit it to a list of hosts.
- **spoond**: microVMs with per-repository egress allowlists, snapshots and suspend/resume.
  `SCOUT_SANDBOX_DRIVER=spoond`, `SCOUT_SPOOND_URL`, `SCOUT_SPOOND_TOKEN`, and `SCOUT_SPOOND_TRANSPORT=rest` on
  spoond 3.11+.
- **local**: no isolation at all; for tests and trying things on a laptop only.

## 6. The model

`SCOUT_MODEL=anthropic/claude-opus-5-5` with `ANTHROPIC_API_KEY` (or an OpenAI model with `OPENAI_API_KEY`). Through
a gateway: `SCOUT_GATEWAY_URL` and `SCOUT_GATEWAY_KEY`, and `SCOUT_MODEL=gateway/<name>` for models only the gateway
knows. Set `SCOUT_PRICES_FILE` for models the built-in prices don't cover, so budgets count them.

## 7. The profile

What Scout knows lives in files: a system prompt, skills, per-channel instructions. `profile/` here is a starter.
Copy it into a repository of its own and point Scout at it (`SCOUT_PROFILE_REPO_URL`, `SCOUT_PROFILE_REPO_SLUG`,
`SCOUT_PROFILE_DIR`); Scout keeps it pulled, and every night proposes changes to it as a pull request. Protect its
main branch so Scout can only propose.

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
npm run doctor   # every integration: ✅, ⚠️ or ❌, with how to fix it; exits 1 if anything is broken
npm start
```

Mention `@Scout` in one of its channels. Its startup log says which Slack features are on and why the rest aren't.
In Slack, `/scout doctor` runs the same checks.

To run it as a service, a systemd unit with `WorkingDirectory=` this checkout, `ExecStart=node --env-file=.env
src/main.ts`, and its own user is enough; [operations.md](operations.md) covers backups, secrets, telemetry and the
dashboard.

## 11. Keeping it up to date

`git pull`, `npm ci`, and restart, ideally when Scout is idle: runs survive a restart, but a reply being written at
that moment is delayed. Paste the Slack manifest again if it changed.
