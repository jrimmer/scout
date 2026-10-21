# Evals: testing Scout's changes before they ship

When the nightly reflection proposes a profile change, or you consider another model, reading the change tells you
what it says, not what it does. Evals run Scout on a set of real tasks with the change and without it, a few times
each, and compare:

```
| Task | Before | Cost | Time | With the change | Cost | Time |
|---|---|---|---|---|---|---|
| fix-median-sorting | 2/3 | $0.21 | 2m10 | 3/3 | $0.18 | 1m55 |
| readme-running-tests | 3/3 | $0.05 | 0m40 | 3/3 | $0.05 | 0m38 |
| **All** | 5/6 | $0.78 | 1m25 | 6/6 | $0.69 | 1m17 |

Better on: fix-median-sorting. Worse on: nothing.
```

## Tasks

Tasks live in the profile repository under `evals/`, one JSON file each:

```json
{
	"name": "fix-median-sorting",
	"repo": "playground",
	"ref": "d8004327781936ce280b57930fa41d20437a7937",
	"request": "median sorts numbers as strings; fix it and add tests.",
	"check": {
		"command": "python3 -m unittest",
		"expect": { "changed": ["tally/stats.py"], "unchanged": ["README.md"] },
		"rubric": "median sorts numerically and averages the two middle values on an even count"
	}
}
```

- `repo` is a configured repository's name, and `ref` the commit the work starts from (a full or short hash).
- `request` is what a person would ask, as they'd ask it.
- `check` needs at least one of:
  - `command`, run in the sandbox after the work, in the repository; exit 0 passes;
  - `expect`, files that must (`changed`) or mustn't (`unchanged`) differ from `ref`, new files included;
  - `rubric`, a plain-language expectation a model judges the answer and the diff against (PASS or FAIL, and why).
    Use it where a command can't tell, and keep it specific: it costs a model call per run.

Good tasks come from real threads: ones whose pull requests were merged as Scout wrote them, and ones where someone
had to correct Scout (with the corrected outcome as the check).

## Running them

```bash
npm run eval -- --profile <candidate profile> --baseline <current profile> --tries 3
npm run eval -- --model gateway/another-model                 # the same profile, another model
npm run eval -- --only median --tries 1                        # one task, once
npm run eval -- --profile . --baseline /tmp/main --comment jrimmer/scout-profile#7
```

- `--profile` defaults to Scout's profile directory (`SCOUT_PROFILE_DIR`); tasks come from its `evals/`, or `--tasks`.
- Without `--baseline`, it runs the candidate alone and reports passes.
- `--comment owner/repo#N` posts the report on that pull request (a profile proposal, say) as Scout.
- It exits 1 if any run with the candidate failed.
- The report says where a run's time went: model calls waiting for their first token (timed on the stream, from
  sending the call), the model answering, the first tool call (the sandbox and the clone), other tools by name,
  pull requests' self-reviews (a model run inside `open_pull_request`), retries, and the rest: Scout and Pi Durable
  between steps.

**Nothing leaves the host.** Each task runs in a fresh sandbox from the configured driver, on a local copy of the
repository at `ref` (made from Scout's mirror), and its pull request goes to a stand-in code host that only agrees.
No MCP servers, no Slack, and the real code host token is never used by a run; only `--comment` uses it, after.

## What it costs, and when to run it

Each run is a whole task with the model: with 10 tasks, 3 tries and a baseline that's 60 runs. It prints the
count first and won't start past `--max-runs` (default 60) without `--yes`. Runs are one at a time.

Run it weekly, on a profile proposal you're unsure about, or before switching models; not on every nightly change.
