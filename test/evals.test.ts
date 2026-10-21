import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.ts";
import { evalConfig, evalRepos, fakeCodeHost, guard, loadTasks, parseTask, report, type RunResult, runTask } from "../src/evals.ts";
import { openScout } from "../src/scout.ts";
import { bareRepo } from "./helpers.ts";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

describe("evals", () => {
	it("reads tasks, and says which file is wrong and how", () => {
		const dir = mkdtempSync(join(tmpdir(), "scout-evals-"));
		writeFileSync(join(dir, "a.json"), JSON.stringify({ name: "fix-median", repo: "playground", ref: "abc1234", request: "fix median", check: { command: "python3 -m unittest", expect: { changed: ["tally/stats.py"] } } }));
		writeFileSync(join(dir, "notes.md"), "not a task");
		assert.deepEqual(loadTasks(dir), [{ name: "fix-median", repo: "playground", ref: "abc1234", request: "fix median", check: { command: "python3 -m unittest", expect: { changed: ["tally/stats.py"] } } }]);
		assert.throws(() => parseTask({ name: "x", repo: "r", ref: "abc1234", request: "y" }, "b.json"), /b\.json: needs a check/);
		assert.throws(() => parseTask({ name: "x", repo: "r", ref: "main", request: "y", check: { rubric: "z" } }, "c.json"), /"ref" must be a commit hash/);
		assert.throws(() => parseTask({ repo: "r", ref: "abc1234", request: "y", check: { rubric: "z" } }, "d.json"), /d\.json: "name" must be a non-empty string/);
		writeFileSync(join(dir, "b.json"), JSON.stringify({ name: "fix-median", repo: "r", ref: "abc1234", request: "y", check: { rubric: "z" } }));
		assert.throws(() => loadTasks(dir), /two tasks are named fix-median/);
		assert.deepEqual(loadTasks(join(dir, "nowhere")), []);
	});

	it("won't start a costly set without --yes", () => {
		assert.deepEqual(guard({ tasks: 10, tries: 3, sides: 2 }, 60, false), { runs: 60, ok: true, say: "10 tasks × 3 tries × 2 sides = 60 runs" });
		const big = guard({ tasks: 11, tries: 3, sides: 2 }, 60, false);
		assert.equal(big.ok, false);
		assert.match(big.say, /66 runs, more than --max-runs 60\. Add --yes/);
		assert.equal(guard({ tasks: 11, tries: 3, sides: 2 }, 60, true).ok, true);
		assert.equal(guard({ tasks: 1, tries: 1, sides: 1 }, 60, false).say, "1 task × 1 try × 1 side = 1 run");
	});

	it("compares a change with what's there now, task by task", () => {
		const r = (task: string, side: "candidate" | "baseline", pass: boolean, cost = 0.1, ms = 60_000): RunResult => ({ task, side, pass, why: pass ? "passed" : "tests failed", cost, ms, steps: 5 });
		const text = report(
			[r("median", "baseline", false), r("median", "baseline", true), r("median", "candidate", true), r("median", "candidate", true), r("readme", "baseline", true), r("readme", "candidate", false, 0.2, 90_000), r("readme", "candidate", true)],
			["candidate", "baseline"],
		);
		assert.match(text, /^\| Task \| Before \| Cost \| Time \| With the change \| Cost \| Time \|/);
		assert.match(text, /\| median \| 1\/2 \| \$0\.10 \| 1m00 \| 2\/2 \| \$0\.10 \| 1m00 \|/);
		assert.match(text, /\| readme \| 1\/1 \| \$0\.10 \| 1m00 \| 1\/2 \| \$0\.15 \| 1m15 \|/);
		assert.match(text, /\| \*\*All\*\* \| 2\/3 \| \$0\.30 \| 1m00 \| 3\/4 \| \$0\.50 \| 1m08 \|/);
		assert.match(text, /Better on: median\. Worse on: readme\./);
		assert.match(text, /- readme \(with the change\): tests failed/);
		assert.doesNotMatch(report([r("median", "candidate", true)], ["candidate"]), /Before|Better on/);
	});

	it("runs a task hermetically in a sandbox on its own copy, and checks the result there", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-eval-run-")));
		const remote = bareRepo(root, "app");
		const ref = git("--git-dir", remote, "rev-parse", "main");
		// The repository moves on after the task's commit: the run must start from `ref`, not the tip.
		const seed = join(root, "app-seed");
		writeFileSync(join(seed, "LATER.md"), "later\n");
		git("-C", seed, "add", ".");
		git("-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", "later");
		git("-C", seed, "push", "--quiet", remote, "main");
		mkdirSync(join(root, "profile"));
		const base = loadConfig({
			SCOUT_MODEL: "faux/m",
			SCOUT_REPO_URL: remote,
			SCOUT_REPO_SLUG: "o/app",
			SCOUT_CODEHOST_TOKEN: "real-token",
			SCOUT_CODEHOST_API: "http://forge.invalid/api/v1",
			SCOUT_DATA_DIR: join(root, "data"),
			SCOUT_PROFILE_DIR: join(root, "profile"),
			SCOUT_SANDBOX_DRIVER: "local",
		});
		const tasks = [
			{ name: "add-fix", repo: "app", ref, request: "add fix.txt", check: { command: "test -f fix.txt && test ! -f LATER.md", expect: { changed: ["fix.txt"], unchanged: ["README.md"] } } },
		];
		const { repos, nameOf } = await evalRepos(base, tasks, join(root, "eval-repos"));
		assert.equal(nameOf(tasks[0]!), `app@${ref.slice(0, 12)}`);
		const host = await fakeCodeHost();
		const config = evalConfig(base, { repos, profileDir: join(root, "profile"), apiUrl: host.apiUrl, dataDir: join(root, "eval-data") });
		assert.equal(config.codeHost.token, "eval", "the real token never goes near a run");
		assert.equal(config.mcpFile, undefined);

		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const scout = await openScout({ config, storage: new MemoryStorage(), dataDir: config.dataDir, instance: "e", context, models, watchProfile: false, mcp: [] });
		try {
			faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "echo fixed > fix.txt" })], { stopReason: "toolUse" }), fauxAssistantMessage("Added fix.txt.")]);
			const passed = await runTask(scout, tasks[0]!, nameOf(tasks[0]!), "candidate", context);
			assert.equal(passed.pass, true, passed.why);
			assert.equal(passed.steps, 1);

			faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "echo oops > README.md" })], { stopReason: "toolUse" }), fauxAssistantMessage("Done.")]);
			const failed = await runTask(scout, tasks[0]!, nameOf(tasks[0]!), "candidate", context);
			assert.equal(failed.pass, false);
			assert.match(failed.why, /exited 1/);
			assert.match(failed.why, /fix\.txt should have changed and didn't; README\.md changed and shouldn't have/);
			assert.equal(git("--git-dir", remote, "rev-parse", "main"), git("-C", seed, "rev-parse", "HEAD"), "the real repository is untouched");
		} finally {
			await scout.close();
			await host.close();
		}
	});
});
