import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { loadConfig } from "../src/config.ts";
import { evalConfig, evalRepos, fakeCodeHost, guard, LOCATE_FORMAT, loadTasks, located, measures, parseTask, report, type RunResult, runTask } from "../src/evals.ts";
import { openScout } from "../src/scout.ts";
import { bareRepo, tempDir } from "./helpers.ts";

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();

describe("evals", () => {
	it("reads tasks, and says which file is wrong and how", () => {
		const dir = tempDir("scout-evals-");
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

	it("reads replayed commits: files given at the start, tests hidden until after, and where a bug is", () => {
		const fix = "1111111111111111111111111111111111111111";
		const replay = parseTask({ name: "r", repo: "app", ref: "abc1234", request: "fix it", check: { hidden: { ref: fix, paths: ["test/a.test.ts"] }, command: "node --test test/a.test.ts" } }, "r.json");
		assert.deepEqual(replay.check.hidden, { ref: fix, paths: ["test/a.test.ts"] });
		const locate = parseTask({ name: "l", kind: "locate", repo: "app", ref: "abc1234", request: "where?", given: { ref: fix, paths: ["test/a.test.ts"] }, check: { locate: { file: "src/a.ts", functions: ["f"] } } }, "l.json");
		assert.equal(locate.kind, "locate");
		assert.deepEqual(locate.given, { ref: fix, paths: ["test/a.test.ts"] });
		assert.throws(() => parseTask({ name: "l", kind: "locate", repo: "app", ref: "abc1234", request: "where?", check: { command: "true" } }, "m.json"), /m\.json: a "locate" task needs "check\.locate"/);
		assert.throws(() => parseTask({ name: "x", repo: "app", ref: "abc1234", request: "y", check: { hidden: { ref: "main", paths: ["a"] }, command: "true" } }, "h.json"), /"check\.hidden\.ref" must be a commit hash/);
		assert.throws(() => parseTask({ name: "x", kind: "guess", repo: "app", ref: "abc1234", request: "y", check: { command: "true" } }, "k.json"), /"kind" must be "change" or "locate"/);
	});

	it("takes the last LOCATION line of an answer, and the function's own name", () => {
		const want = { file: "src/doctor.ts", functions: ["checkRunning", "fetchRunning"] };
		assert.deepEqual(located("It's in the fetch.\n\nLOCATION: src/doctor.ts fetchRunning", want), { pass: true, why: "passed" });
		assert.equal(located("LOCATION: `./src/doctor.ts` `Doctor.checkRunning()`", want).pass, true);
		assert.equal(located("LOCATION: src/a.ts f\nOn second thoughts:\nLOCATION: src/doctor.ts checkRunning", want).pass, true);
		assert.deepEqual(located("LOCATION: src/main.ts checkRunning", want), { pass: false, why: "named src/main.ts, not src/doctor.ts" });
		assert.deepEqual(located("LOCATION: src/doctor.ts doctor", want), { pass: false, why: "named doctor in src/doctor.ts, not checkRunning or fetchRunning" });
		assert.equal(located("It's in doctor.ts somewhere.", want).why, "the answer has no LOCATION line");
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
		const root = tempDir("scout-eval-run-");
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

	it("replays a commit: its tests hidden while the work runs, a failing test given for a locate task, and what the run used", async () => {
		const root = tempDir("scout-eval-replay-");
		const remote = bareRepo(root, "app");
		const seed = join(root, "app-seed");
		const commit = (message: string) => {
			git("-C", seed, "add", ".");
			git("-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "--quiet", "-m", message);
			git("-C", seed, "push", "--quiet", remote, "main");
			return git("-C", seed, "rev-parse", "HEAD");
		};
		writeFileSync(join(seed, "value.txt"), "1\n");
		writeFileSync(join(seed, "keep.txt"), "kept\n");
		// A test that held the old behaviour, which the fix changes along with it.
		mkdirSync(join(seed, "t"));
		writeFileSync(join(seed, "t", "old.sh"), 'test "$(cat value.txt)" = 1\n');
		const parent = commit("one");
		writeFileSync(join(seed, "value.txt"), "2\n");
		writeFileSync(join(seed, "t", "check.sh"), 'test "$(cat value.txt)" = 2\n');
		writeFileSync(join(seed, "t", "old.sh"), 'test "$(cat value.txt)" -ge 1\n');
		const fix = commit("two, and its test");
		mkdirSync(join(root, "profile"));
		const base = loadConfig({
			SCOUT_MODEL: "faux/m",
			SCOUT_REPO_URL: remote,
			SCOUT_REPO_SLUG: "o/app",
			SCOUT_CODEHOST_TOKEN: "t",
			SCOUT_CODEHOST_API: "http://forge.invalid/api/v1",
			SCOUT_DATA_DIR: join(root, "data"),
			SCOUT_PROFILE_DIR: join(root, "profile"),
			SCOUT_SANDBOX_DRIVER: "local",
		});
		const change = parseTask({ name: "two", repo: "app", ref: parent, request: "value should be 2", check: { hidden: { ref: fix, paths: ["t/check.sh", "t/old.sh"] }, command: "sh t/check.sh", suite: 'test "$(cat keep.txt)" = kept && sh t/old.sh' } }, "two.json");
		const locate = parseTask({ name: "where", kind: "locate", repo: "app", ref: parent, request: "t/check.sh fails. Where?", given: { ref: fix, paths: ["t/check.sh"] }, check: { locate: { file: "value.txt", functions: ["two"] } } }, "where.json");
		const { repos, nameOf, fileAt } = await evalRepos(base, [change, locate], join(root, "eval-repos"));
		assert.equal(nameOf(locate), `app@${parent.slice(0, 12)}+${fix.slice(0, 12)}`);
		const host = await fakeCodeHost();
		const config = evalConfig(base, { repos, profileDir: join(root, "profile"), apiUrl: host.apiUrl, dataDir: join(root, "eval-data") });
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const measured = measures();
		const scout = await openScout({ config, storage: new MemoryStorage(), dataDir: config.dataDir, instance: "r", context, models, watchProfile: false, mcp: [], modelStarted: measured.modelStarted });
		try {
			// The test isn't there while the work runs: with it, this would leave value.txt alone.
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", {})], { stopReason: "toolUse" }),
				fauxAssistantMessage([fauxToolCall("bash", { command: "test ! -e t/check.sh && echo 2 > value.txt" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("Set it to 2."),
			]);
			const fixed = await runTask(scout, change, nameOf(change), "candidate", context, measured, { fileAt });
			assert.equal(fixed.pass, true, fixed.why);
			assert.equal(fixed.usage?.toolCalls, 2);
			assert.equal(fixed.usage?.badToolCalls, 1, "a bash call without a command is malformed");
			assert.equal(fixed.usage?.modelCalls, 3);
			assert.equal(fixed.usage?.firstTokens.length, 3);
			assert.equal(fixed.regressed, false, "what worked still works, judged by the tests as the fix left them");

			faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "echo 2 > value.txt && rm keep.txt" })], { stopReason: "toolUse" }), fauxAssistantMessage("Set it to 2.")]);
			const broke = await runTask(scout, change, nameOf(change), "candidate", context, measured, { fileAt });
			assert.equal(broke.pass, true, "the new tests pass: that's coding, scored apart");
			assert.equal(broke.regressed, true);
			assert.match(broke.why, /broke the repository's tests/);

			faux.setResponses([fauxAssistantMessage("Nothing to change.")]);
			const unfixed = await runTask(scout, change, nameOf(change), "candidate", context, measured, { fileAt });
			assert.equal(unfixed.pass, false);
			assert.match(unfixed.why, /`sh t\/check\.sh` exited 1/);
			assert.equal(unfixed.regressed, undefined, "no change, nothing to check");

			let asked = "";
			faux.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "cat t/check.sh" })], { stopReason: "toolUse" }),
				(transcript) => {
					asked = JSON.stringify(transcript);
					return fauxAssistantMessage("The test wants 2.\n\nLOCATION: value.txt two");
				},
			]);
			const found = await runTask(scout, locate, nameOf(locate), "candidate", context, measured, { fileAt });
			assert.equal(found.pass, true, found.why);
			assert.ok(asked.includes("LOCATION: <file path> <function name>"), "the request says how to answer");
			assert.ok(asked.includes("cat value.txt"), "the failing test was there from the start");

			// A model that isn't set up never gets a call: that's left unscored, not counted as the model failing.
			const missing = await openScout({ config: evalConfig(base, { repos, profileDir: join(root, "profile"), apiUrl: host.apiUrl, dataDir: join(root, "eval-data-missing"), model: { provider: "faux", modelId: "missing" } }), storage: new MemoryStorage(), dataDir: join(root, "eval-data-missing"), instance: "r2", context, models, watchProfile: false, mcp: [] });
			try {
				const none = await runTask(missing, change, nameOf(change), "candidate", context, measures(), { fileAt });
				assert.equal(none.pass, false);
				assert.equal(none.unscored, "no model call was made", none.why);
			} finally {
				await missing.close();
			}

			// Last: a stopped run can still be finishing its command when the next one starts.
			faux.setResponses([fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 5" })], { stopReason: "toolUse" }), fauxAssistantMessage("Done.")]);
			const slow = await runTask(scout, change, nameOf(change), "candidate", context, measured, { fileAt, limitMs: 60_000, wallMs: 500 });
			assert.equal(slow.pass, false);
			assert.match(slow.why, /^the provider kept it waiting: not done within 0 minutes/);
			assert.equal(slow.unscored, slow.why.split(";")[0], "the provider's doing, not the model's");
			assert.ok(slow.ms < 4_000, "stopped at the limit, not after the command");
		} finally {
			await scout.close();
			await host.close();
		}
	});
});
