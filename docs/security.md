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

- **Who may ask** is checked for every request, and is on by default (`SCOUT_REQUESTER_CHECK=enforce`; `off` is
  for test installs, and the doctor fails it when a repository is public): in Slack by the person's identity, on the
  code host by their login. Every person asking is checked, not only the last; an assignment is checked as a request
  from whoever assigned it. A comment from someone who may not ask is answered with a polite no, not acted on.
- **Logins aren't identities** unless the code host signs people in through your directory (a Forgejo behind it). On
  GitHub anyone can register any free login, so a GitHub login is linked to a person only through the people file
  (`SCOUT_CODEHOST_LOGINS`), never by sharing a name with someone in the directory.
- **Reading other repositories** (`search_code`, `read_code`) is limited to the thread's own repository and those
  the person asking may ask for work in: someone admitted on a public repository can't have Scout read a private one.
- **`/scout`** answers `doctor` only to admins (it shows how Scout is set up), the other commands only to people who
  may ask for work in that channel's repository, and starts work with `ask` only in public channels Scout is in, so
  nothing from a private channel or a DM reaches threads or search.
- **The sandbox** holds nothing worth stealing and reaches only what its egress list allows; exfiltration needs a
  host on that list.
- **Approvals** gate tool writes and network access; Scout's own requests are never enough (see below).
- **Pull requests** are reviewed by people before anything reaches a base branch. Scout's reviews of other people's
  pull requests are always comments, never approvals or requests for changes, so they never count towards what
  branch protection asks for, whatever a pull request's text talks the reviewer into.
- **Credentials in a push.** Before pushing, the host scans everything the push would publish that the code host
  doesn't have yet: every new commit (not only the net diff), each commit's message, every added line however big
  the change, files git calls binary, base64 that decodes to a credential, and the pull request's title and
  description. A match refuses the push, naming the commit, the file and the kind of credential, never its value. This
  scan is the control. It knows common token shapes and the exact values of Scout's own secrets; a credential it has
  no pattern for, or one encoded some other way (reversed, split across lines), gets through, so keep secrets out of
  repositories Scout works on.
- **The self-review is a second look, not a gate.** Scout reviews its own change before opening a pull request and
  fixes what it agrees with, but it may disagree and open the pull request anyway, saying so in the description. Text
  that talks the model into that gets past it. It catches slop, not attacks. To keep it quick, it reads the diff and
  one round of other files, then answers; the credential scan above runs on every push whatever the review does.
- **MCP results are redacted** for credentials before the model sees them, the same way as errors in threads, the
  audit trail and the search index: common token shapes, and the values of Scout's own secrets (`SCOUT_GATEWAY_KEY`,
  the code host and Slack tokens, the spoond and metrics tokens, Litestream's keys, the MCP servers' `${NAME}`
  values). Redaction is pattern matching too: a read-only MCP server still shouldn't hand out credentials.
- **Notes Scout keeps** are shown with its answers so people can object, expire unless reviewed, and are framed to
  the model as hints, never instructions.

Be careful with public repositories (anyone can open an issue or comment) and with MCP servers that can write:
keep those behind approval.

## Approvals

**Tool writes** (MCP servers with `writes: approve`). An approval is bound to the change it was asked for: the server,
the tool, and a hash of the arguments, recorded when the call was refused for want of one. It's taken only while that
change is waiting in Scout's answer, only from "approve" alone, a 👍 on that answer, or the Approve button (not "go
ahead", which answers any question), and only from someone who may approve changes to that server. The call goes ahead
only if it matches exactly; a run steered in between that changes the call needs a new approval. One approval covers
one call, for 15 minutes. Decline counts only from someone who may approve the change, and takes back an approval not
yet used.

**Network for sandboxes** (`ask_for_network`). Allowing a host lets every new sandbox for that repository reach it from
now on, so only people the roles file names for `egress` decide; `*` doesn't cover it, and with no one named nobody
can allow a host from Slack. The question names the host first and labels the model's reason as Scout's, in plain
text, since a prompt injection can write it. Scout refuses to ask for IP addresses and ranges, names inside a network
(`localhost`, `.internal`, `.local`, cloud metadata names), and wildcards wider than one registrable domain, because
an allowlisted private address gets through spoond's firewall. A public name that resolves to a private address is
the substrate's to stop: spoond checks resolved addresses at connect time and refuses private, link-local and host
addresses the allowlist doesn't name itself.

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

## Known limits

What the controls above don't cover, so you can decide what else your deployment needs:
- **Credential patterns:** the push scan and the redactor know common token shapes and the exact values of Scout's own
  secrets. A credential with no known shape, a bare 40-character hex token with no label (it looks like a git commit
  hash), or one reversed, split or encoded some other way gets through.
- **The self-review** is a second look, not a gate (see above).
- **Names that resolve to private addresses:** Scout refuses IP addresses, internal names and over-broad wildcards as
  egress hosts, but a public name that resolves to a private address is the sandbox substrate's to block (spoond does
  this when a sandbox connects).
- **Stopping at the wrong instant:** a stop or a drain waits for an answer's copy to the code host, but in the moment
  between the answer reaching Slack and the copy starting, the copy can be lost.
- **The dashboard speaks plain HTTP:** off loopback, put it behind TLS or keep it on a private network.

## Data

Thread transcripts, notes, schedules and the audit trail are in Scout's data directory (SQLite). Retention
(`SCOUT_RETENTION_DAYS`) deletes what quiet threads leave behind; transcripts in Pi Durable's store are not yet
deleted. Back the data directory up (see operations.md, Backups).

Answers to requests made on the code host are posted back there: in full on private repositories, only a pointer to
the Slack thread on public ones, since an answer can draw on anything said in Slack.

## Reporting

If you find a way to make Scout act outside these limits, report it privately to whoever maintains your deployment
before posting it anywhere public.
