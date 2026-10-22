import assert from "node:assert/strict";
import { request } from "node:http";
import { describe, it } from "node:test";
import { type BenchRow, BenchStore, benchRow, logScale, quantile, relate, score } from "../src/bench.ts";
import { tonight } from "../src/bench-cli.ts";
import { loadConfig } from "../src/config.ts";
import type { Collector } from "../src/dash/collect.ts";
import { radar } from "../src/dash/bench.ts";
import { startDashboard } from "../src/dash/server.ts";
import { type EvalTask, loadTasks } from "../src/evals.ts";
import { busy } from "./fixtures/snapshot.ts";

const row = (over: Partial<BenchRow> = {}): BenchRow => ({
	model: "gateway/a",
	run: "2026-10-22",
	task: "t1",
	kind: "change",
	pass: true,
	ms: 120_000,
	cost: 0.05,
	toolCalls: 10,
	badToolCalls: 0,
	modelCalls: 8,
	retries: 0,
	inputTokens: 50_000,
	outputTokens: 4_000,
	modelMs: 40_000,
	firstTokenP50: 1_000,
	firstTokenP90: 4_000,
	...over,
});

const get = (port: number, path: string) =>
	new Promise<{ status: number; body: string }>((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path }, (res) => {
			let body = "";
			res.on("data", (c) => (body += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
		});
		req.on("error", reject);
		req.end();
	});

describe("benchmark", () => {
	it("scores on fixed scales, so a score means the same next week", () => {
		assert.equal(logScale(500, 500, 60_000), 100);
		assert.equal(logScale(60_000, 500, 60_000), 0);
		assert.equal(logScale(120_000, 500, 60_000), 0, "worse than the worst is 0");
		assert.equal(logScale(5_477, 500, 60_000), 50, "halfway on a log scale");
		assert.equal(logScale(200, 200, 5), 100, "higher is better when best is above worst");
		assert.equal(logScale(0, 200, 5), 0);
		assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
		assert.equal(quantile([], 0.9), 0);
	});

	it("scores what a model can do and what it's like to work with, over its runs", () => {
		const rows = [
			row({ task: "fix", run: "2026-10-21" }),
			row({ task: "fix", run: "2026-10-22", pass: false, badToolCalls: 2, retries: 2, regressed: true }),
			row({ task: "fix2", run: "2026-10-22", regressed: false }),
			row({ task: "where", kind: "locate", run: "2026-10-21" }),
			row({ task: "where", kind: "locate", run: "2026-10-22" }),
		];
		const s = score("gateway/a", rows);
		assert.equal(s.runs, 2);
		const cap = Object.fromEntries(s.capability.map((a) => [a.name, a]));
		assert.equal(cap.Coding!.score, 67);
		assert.equal(cap["Reasoning (finding bugs)"]!.score, 100);
		assert.equal(cap["Tool use"]!.score, 96, "2 bad calls in 50");
		assert.deepEqual([cap["No regressions"]!.score, cap["No regressions"]!.value], [50, "1/2 changes"], "only changes that were checked count");
		assert.equal(cap["Cost efficiency"]!.value, "$0.063 a solved task");
		const ops = Object.fromEntries(s.operations.map((a) => [a.name, a]));
		assert.equal(ops["First token"]!.value, "1.0s");
		assert.equal(ops["Output speed"]!.value, "100 tokens/s");
		assert.equal(ops["Call success"]!.value, "2 retried of 42 calls", "raw counts");
		assert.equal(ops["Task time"]!.value, "2.0m");
		assert.equal(ops["Tasks not lost"]!.value, "0 lost of 5 tasks");
		assert.equal(score("gateway/a", [row()]).capability.find((a) => a.name === "No regressions")!.value, "no change to check yet");
	});

	it("charts working with it relative to the other models, the best on each spoke at the outer ring", () => {
		const [a, b] = relate([score("gateway/a", [row({ firstTokenP50: 1_000, outputTokens: 4_000 })]), score("gateway/b", [row({ model: "gateway/b", firstTokenP50: 4_000, outputTokens: 1_000, retries: 8 })])]);
		const ops = (m: typeof a) => Object.fromEntries(m!.operations.map((x) => [x.name, x.score]));
		assert.deepEqual([ops(a)["First token"], ops(b)["First token"]], [100, 25], "a quarter as fast to start");
		assert.deepEqual([ops(a)["Output speed"], ops(b)["Output speed"]], [100, 25]);
		assert.deepEqual([ops(a)["Call success"], ops(b)["Call success"]], [100, 50], "8 retries in 16 calls");
		assert.equal(relate([score("gateway/a", [row()])])[0]!.operations.every((x) => x.score === 100), true, "alone, a model is its own best");
	});

	it("leaves tasks the provider cut short out of what the model can do, and counts them against working with it", () => {
		const rows = [row({ task: "fix" }), row({ task: "slow", pass: false, unscored: "the provider kept it waiting", ms: 90 * 60_000 })];
		const s = score("gateway/a", rows);
		const cap = Object.fromEntries(s.capability.map((a) => [a.name, a]));
		assert.equal(cap.Coding!.score, 100, "the cut-short task isn't the model's failure");
		assert.equal(cap["Tool use"]!.value, "0 bad of 10", "the cut-short task's calls aren't counted");
		const ops = Object.fromEntries(s.operations.map((a) => [a.name, a]));
		assert.equal(ops["Tasks not lost"]!.value, "1 lost of 2 tasks");
		assert.equal(ops["Task time"]!.value, "46.0m", "its time still counts here");
	});

	it("keeps only each model's last runs, and nothing but a summary of each", () => {
		const store = new BenchStore(":memory:");
		for (let day = 1; day <= 12; day++) {
			const run = `2026-10-${String(day).padStart(2, "0")}`;
			store.record([row({ run }), row({ run, model: "gateway/b" })], 10);
		}
		assert.deepEqual([...new Set(store.rows("gateway/a").map((r) => r.run))], Array.from({ length: 10 }, (_, i) => `2026-10-${String(i + 3).padStart(2, "0")}`));
		assert.equal(store.lastRun(), "2026-10-12");
		assert.deepEqual(store.scores().map((s) => s.model).sort(), ["gateway/a", "gateway/b"]);
		const kept = benchRow("gateway/a", "2026-10-12", { name: "t", repo: "r", ref: "abc1234", request: "x", check: { command: "true" } }, {
			task: "t",
			side: "candidate",
			pass: true,
			why: "passed",
			cost: 0.1,
			ms: 1000,
			steps: 3,
			usage: { toolCalls: 3, badToolCalls: 0, modelCalls: 4, retries: 0, inputTokens: 10, outputTokens: 5, firstTokens: [400, 100, 300, 200] },
		});
		assert.equal(kept.firstTokenP50, 250);
		assert.equal(Object.keys(kept).some((k) => /why|answer|diff|transcript/.test(k)), false);
		store.close();
	});

	it("draws one outline per model on a radar, with its numbers on hover", () => {
		const s = score("gateway/a", [row()]);
		const svg = radar([s.capability], ["gateway/a"]);
		assert.equal((svg.match(/<polygon class="ring"/g) ?? []).length, 4);
		assert.match(svg, /<g class="s0"><polygon points="[^"]+"\/>/);
		assert.match(svg, /<title>gateway\/a: Coding 100 \(1\/1\)<\/title>/);
		assert.match(svg, /aria-label="gateway\/a: Coding 100, Reasoning \(finding bugs\) 0,/);
	});

	it("is off unless SCOUT_BENCH_MODELS names models, and its footer link only shows when it's on", async () => {
		const base = { SCOUT_REPO_URL: "x", SCOUT_REPO_SLUG: "o/r", SCOUT_CODEHOST_TOKEN: "t", SCOUT_CODEHOST_API: "http://f/api/v1" };
		assert.equal(loadConfig(base).bench, undefined);
		const on = loadConfig({ ...base, SCOUT_BENCH_MODELS: "gateway/lunaroute/beam, gateway/lunaroute/glm-5.3" }).bench!;
		assert.deepEqual(on.models, [{ provider: "gateway", modelId: "lunaroute/beam" }, { provider: "gateway", modelId: "lunaroute/glm-5.3" }]);
		assert.equal(on.hour, 1);
		assert.throws(() => loadConfig({ ...base, SCOUT_BENCH_MODELS: "beam" }), /should look like provider\/modelId/);
		const gw = loadConfig({ ...base, SCOUT_MODEL: "gateway/lunaroute/flash", SCOUT_GATEWAY_URL: "http://gw", SCOUT_BENCH_MODELS: "gateway/lunaroute/beam,gateway/lunaroute/flash" });
		assert.deepEqual(gw.gateway?.models, ["lunaroute/flash", "lunaroute/beam"], "the gateway knows the models the benchmark runs");

		const collector = { collect: async () => busy } as unknown as Collector;
		const off = await startDashboard({ addr: "127.0.0.1:0", collector });
		assert.equal((await get(off.port, "/bench")).status, 404);
		assert.doesNotMatch((await get(off.port, "/")).body, /benchmark/i);
		await off.close();

		const scores = [score("gateway/a", [row()]), score("gateway/b", [row({ model: "gateway/b", pass: false })])];
		const dash = await startDashboard({ addr: "127.0.0.1:0", collector, bench: () => ({ scores, lastRun: "2026-10-22", keep: 10, hour: 1, tasks: 7 }) });
		const empty = await startDashboard({ addr: "127.0.0.1:0", collector, bench: () => ({ scores: [], keep: 10, hour: 1, tasks: 7 }) });
		try {
			const home = (await get(dash.port, "/")).body;
			assert.match(home, /<span class="g-dim">scout · read-only · <\/span><a href="\/bench" class="g-dim">benchmark<\/a>/, "in the grid's last line, styled like it");
			assert.doesNotMatch(home, /<nav|<footer/);
			const page = (await get(dash.port, "/bench")).body;
			assert.match(page, /7 tasks from Scout's own history/);
			assert.match(page, /<footer class="links"><a href="\/">dashboard<\/a><\/footer>/);
			assert.match(page, /<figcaption>What it can do<\/figcaption>/);
			assert.match(page, /<figcaption>Working with it<\/figcaption>/);
			assert.match(page, /<li class="s1"><i><\/i>gateway\/b/);
			assert.doesNotMatch(page, /<script|style=/, "nothing the dashboard's content security policy would block");
			assert.match((await get(empty.port, "/bench")).body, /No runs yet\. They start each night after 01:00/);
		} finally {
			await dash.close();
			await empty.close();
		}
	});

	it("draws the same tasks for every model each night, the ones run longest ago, of each kind", () => {
		const task = (name: string, kind?: "locate"): EvalTask => ({ name, repo: "r", ref: "abc1234", request: "x", ...(kind === undefined ? {} : { kind }), check: { command: "true" } });
		const pool = [task("c1"), task("c2"), task("c3"), task("l1", "locate"), task("l2", "locate"), task("l3", "locate")];
		const last = new Map([["c1", "2026-10-21"], ["c2", "2026-10-19"], ["l1", "2026-10-21"]]);
		const names = tonight(pool, "2026-10-22", last, { change: 2, locate: 2 }).map((t) => t.name);
		assert.deepEqual(names.slice(0, 2), ["c3", "c2"], "never run first, then the oldest");
		assert.deepEqual(names.slice(2).sort(), ["l2", "l3"]);
		assert.deepEqual(tonight(pool, "2026-10-22", last, { change: 2, locate: 2 }), tonight(pool, "2026-10-22", last, { change: 2, locate: 2 }), "the same draw for the same night");
		const store = new BenchStore(":memory:");
		store.record([row({ task: "c1", run: "2026-10-20" }), row({ task: "c1", run: "2026-10-21", model: "gateway/b" })]);
		assert.deepEqual([...store.lastRuns()], [["c1", "2026-10-21"]]);
		store.close();
	});

	it("ships tasks that load: replayed fixes judged by hidden tests, and bugs to find", () => {
		const tasks = loadTasks(new URL("../bench", import.meta.url).pathname);
		assert.ok(tasks.length >= 5);
		for (const t of tasks) {
			if (t.kind === "locate") assert.ok(t.given !== undefined && t.check.locate !== undefined, t.name);
			else assert.ok(t.check.hidden !== undefined && t.check.command !== undefined, t.name);
		}
	});
});
