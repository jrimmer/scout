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
npm run eval -- --profile . --baseline /tmp/main --comment acme/scout-profile#7
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

## The benchmark: models compared on the team's own work

Evals answer "is this change better?". The benchmark answers "how do these models do on our work, and what are they
like to use through our gateway?", night after night. It's **off** unless `SCOUT_BENCH_MODELS` names the models
(`provider/model`, comma-separated); then each night after `SCOUT_BENCH_HOUR` (1 by default), Scout starts
`npm run bench` in a process of its own, and every model runs the same few tasks from the pool once, as an eval
runs: 3 changes and 4 bugs to find, the ones run longest ago, so the pool comes round in turn and no task gets
learned by being there every night (SWE-rebench keeps its tasks fresh for the same reason).
The **Benchmark** page shows the result, linked from the foot of the dashboard. `npm run bench` runs a night by hand (`--only <text>` for
every task whose name has the text).

**The tasks** come from the work of the team Scout is deployed with, never from Scout's own code: fixes that were
merged into the team's repositories, and threads where someone had to correct Scout, with the corrected outcome as the
check. They're the team's private code, so they live with the install, as JSON files in the data directory's `bench/`
(`SCOUT_BENCH_TASKS` names another directory), never in Scout's repository. The Benchmark page shows only the models'
scores and how many tasks there are, never a task's name, request or code. With no tasks yet, there are no runs and
the page says so. They're chosen as public benchmarks choose theirs:
- **Replayed fixes**, as in SWE-bench: Scout starts from the commit before a fix, with a request a person would
  make. The fix's own tests are put in place only after the work (`check.hidden`), so the model can't fit its
  change to tests it saw. It passes when they do: the new tests and the old ones in the same file. If it changed
  anything, the repository's other tests run too (`check.suite`), as SWE-bench checks a fix broke nothing.
- **Finding bugs** (`"kind": "locate"`): the failing test is there from the start (`given`), and the answer must
  end `LOCATION: <file> <function>`, naming the file and a function the real fix changed. Checked exactly, with no
  model judging.
- Tasks have time limits, as public benchmarks do. 30 minutes of the model's own time: a task that needs more fails.
  Time spent waiting for the provider's first tokens, or retrying its failed calls, doesn't count, so a slow provider
  doesn't read as a slow model. And 90 minutes in all, so a slow night can't run into the day: a task cut short by
  that, whose calls kept failing, or that never reached the model, isn't scored as the model's. It counts under
  "Tasks not lost" instead.
- A candidate is a merged change with a small fix and its tests, kept only when its tests fail before the fix and
  pass after it, and the rest of the tests pass before it. Each is a JSON file with the eval task's fields; `repo`
  names one of the team's repositories. A bigger pool comes round less often.

**The charts.** What a model can do is scored 0 to 100 on fixed scales, so a score means the same thing from week to
week and a model added later compares fairly. What it's like to work with is shown as the measurements themselves,
charted relative to each other: on each spoke the best of the models is the outer ring, and the rest are their
share of it. Providers change (capacity added, a bad night), so these are only ever a comparison. Both are over each
model's last 10 nightly runs; only a summary of each run is kept (`bench.sqlite` in the data directory), and the
oldest run goes as each new one comes in.

| What it can do | Measured as |
|---|---|
| Coding | Replayed fixes passed |
| Reasoning (finding bugs) | Bugs located. Not the maths and science quizzes public leaderboards call reasoning |
| Tool use | Tool calls well formed, as in BFCL: arguments that fit, tools that exist |
| No regressions | Changes that left the repository's other tests passing, as SWE-bench's pass-to-pass tests |
| Cost efficiency | List-price cost per solved task, from `SCOUT_PRICES_FILE`: $0.01 is 100, $2 is 0 (log scale) |

| Working with it | Measured as |
|---|---|
| First token | Median time to a model call's first token |
| Slow first tokens | Its 90th percentile |
| Output speed | Tokens a second once answering |
| Task time | Median time for a whole task |
| Call success | Model calls that worked without a retry, as counts |
| Tasks not lost | Tasks the provider didn't cut short (the 90-minute limit, or calls that kept failing), as counts |

It's small: a few tasks, one team's code. Read it as a comparison of models on this work, not a ranking.
Costs come from the prices file, so a model without a price there shows as free; add list prices (OpenRouter's, or
the gateway's own catalog) for every model you compare. The nights cost about a task's worth of model calls per
model per task, a few dollars a week for three models at today's prices.

