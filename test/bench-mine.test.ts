import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { bodyText, candidate, described, draft, fixes, fixSubject, mine } from "../src/bench-mine.ts";
import { loadConfig } from "../src/config.ts";
import { loadTasks } from "../src/evals.ts";
import { seedRepo, tempDir } from "./helpers.ts";

const hasGo = (() => {
	try {
		execFileSync("go", ["version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
})();

const calc = (op: string) => `package calc\n\n// Add adds.\nfunc Add(a, b int) int {\n\treturn a ${op} b\n}\n\nfunc Sub(a, b int) int {\n\treturn a - b\n}\n`;
const calcTest = `package calc\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(2, 3) != 5 {\n\t\tt.Fatal("2+3")\n\t}\n}\n`;
const subTest = `package calc\n\nimport "testing"\n\nfunc TestSub(t *testing.T) {\n\tif Sub(3, 2) != 1 {\n\t\tt.Fatal("3-2")\n\t}\n}\n`;

/** A Go repository with a bug fixed with its test, a fix with none, a feature, and a "fix" whose test passed before it. */
function goRepo(root: string) {
	const repo = seedRepo(root, "app", "main", { "go.mod": "module example.com/app\n\ngo 1.21\n" });
	mkdirSync(join(repo.seed, "calc"));
	const broken = repo.commit({ "calc/calc.go": calc("-") }, "feat: calc");
	const fixed = repo.commit({ "calc/calc.go": calc("+"), "calc/calc_test.go": calcTest }, "fix(calc): sums came out as differences\n\nWHAT: the operator was wrong.\n\nLR-T: calc\nCo-Authored-By: someone <x@y>");
	const untested = repo.commit({ "README.md": "app\n", "calc/calc.go": `${calc("+")}// done\n` }, "fix: a comment");
	const passing = repo.commit({ "calc/calc.go": `${calc("+")}// tidy\n`, "calc/sub_test.go": subTest }, "Fix the tidy");
	repo.push();
	return { ...repo, broken, fixed, untested, passing };
}

describe("finding benchmark tasks in the team's merged fixes", () => {
	it("knows a fix by its subject, and says what it was for without its prefix or trailers", () => {
		assert.equal(fixSubject("fix(api): stop dropping headers"), "fix(api): stop dropping headers");
		assert.equal(fixSubject("Merge pull request 'Fix the login loop' (#12) from x into main"), "Fix the login loop");
		assert.equal(fixSubject("feat: a new thing"), undefined);
		assert.equal(fixSubject("Revert \"fix: x\""), undefined);
		assert.equal(described("fix(api,store)!: stop dropping headers"), "Stop dropping headers.");
		assert.equal(bodyText("WHAT: x\nWHY: y\n\nLR-T: a\nCo-Authored-By: b <c>\nSigned-off-by: d"), "WHAT: x\nWHY: y");
	});

	it("reads a fix that came with tests as a change task and, fixed in one file, a locate task", async () => {
		const root = tempDir("scout-mine-");
		const repo = goRepo(root);
		const found = await fixes(repo.remote, "main");
		assert.deepEqual(found.map((f) => f.commit), [repo.passing, repo.untested, repo.fixed], "fixes only, newest first");
		assert.equal(await candidate(repo.remote, "app", repo.untested, "fix: a comment"), "no tests came with it");
		const c = await candidate(repo.remote, "app", repo.fixed, found[2]!.subject);
		assert.ok(typeof c !== "string", c as string);
		assert.equal(c.lang, "go");
		assert.equal(c.parent, repo.broken);
		assert.deepEqual(c.sources, ["calc/calc.go"]);
		assert.deepEqual(c.tests, ["calc/calc_test.go"]);
		assert.deepEqual(c.functions, { "calc/calc.go": ["Add"] });
		assert.deepEqual(c.testNames, { "calc/calc_test.go": ["TestAdd"] });
		const [change, locate] = await draft(repo.remote, c);
		assert.deepEqual(change, {
			name: `app-${repo.fixed.slice(0, 10)}-change`,
			repo: "app",
			ref: repo.broken,
			request: "Sums came out as differences.\n\nWHAT: the operator was wrong.",
			check: { hidden: { ref: repo.fixed, paths: ["calc/calc_test.go"] }, command: "go test -count=1 -run '^(TestAdd)$' './calc'", suite: "go test -count=1 './calc'" },
		});
		assert.equal(locate?.kind, "locate");
		assert.deepEqual(locate?.given, { ref: repo.fixed, paths: ["calc/calc_test.go"] });
		assert.deepEqual(locate?.check, { locate: { file: "calc/calc.go", functions: ["Add"] } });
		assert.equal(locate?.request, `The test "TestAdd" (calc/calc_test.go) fails. They were written for this fix: "Sums came out as differences". Where does that need fixing?`);
	});

	it("keeps a fix whose tests fail without it and pass with it, and tries no commit twice", { skip: !hasGo && "needs Go" }, async () => {
		const root = tempDir("scout-mine-run-");
		const repo = goRepo(root);
		// Tests of what the fix adds can't build without it; tests that can't build at all are the sandbox's doing.
		const adds = repo.commit({ "calc/calc.go": `${calc("+")}\nfunc Mul(a, b int) int {\n\treturn a * b\n}\n`, "calc/mul_test.go": `package calc\n\nimport "testing"\n\nfunc TestMul(t *testing.T) {\n\tif Mul(2, 3) != 6 {\n\t\tt.Fatal("2*3")\n\t}\n}\n` }, "fix: no way to multiply");
		const nowhere = repo.commit({ "calc/calc.go": `${calc("+")}\nfunc Mul(a, b int) int {\n\treturn a * b\n}\n// again\n`, "calc/far_test.go": `package calc\n\nimport (\n\t"testing"\n\n\t"example.invalid/nowhere"\n)\n\nfunc TestFar(t *testing.T) { nowhere.X() }\n` }, "fix: far");
		repo.push();
		mkdirSync(join(root, "profile"));
		const config = loadConfig({
			SCOUT_MODEL: "faux/m",
			SCOUT_REPO_URL: repo.remote,
			SCOUT_REPO_SLUG: "o/app",
			SCOUT_CODEHOST_TOKEN: "t",
			SCOUT_CODEHOST_API: "http://forge.invalid/api/v1",
			SCOUT_DATA_DIR: join(root, "data"),
			SCOUT_PROFILE_DIR: join(root, "profile"),
			SCOUT_SANDBOX_DRIVER: "local",
			SCOUT_BENCH_MODELS: "faux/m",
		});
		const lines: string[] = [];
		const added = await mine(config, { max: 5, log: (line) => lines.push(line) });
		const id = `app-${repo.fixed.slice(0, 10)}`;
		assert.deepEqual(added, [`${id}-change`, `${id}-locate`], lines.join("\n"));
		assert.deepEqual(loadTasks(config.bench!.tasksDir).map((t) => t.name).sort(), added.sort(), "the tasks it writes are tasks");
		const said = (commit: string, why: string) => assert.ok(lines.some((l) => l.includes(`${commit.slice(0, 10)}: no (${why})`)), lines.join("\n"));
		said(repo.passing, "its tests pass without the fix");
		said(adds, "its tests don't build without the fix");
		said(nowhere, "its tests fail with the fix too");
		const tried = readFileSync(join(config.bench!.tasksDir, "mined.jsonl"), "utf8").trim().split("\n");
		assert.equal(tried.length, 5);
		assert.equal(JSON.parse(tried.find((t) => t.includes(nowhere))!).again, true);
		lines.length = 0;
		assert.deepEqual(await mine(config, { max: 5, log: (line) => lines.push(line) }), [], "nothing new");
		assert.equal(lines.length, 0);
		assert.deepEqual(await mine(config, { max: 5, again: true, log: (line) => lines.push(line) }), []);
		assert.equal(lines.length, 1, "only the one whose tests didn't run is tried again");
		said(nowhere, "its tests fail with the fix too");
	});
});
