import assert from "node:assert/strict";
import { request } from "node:http";
import { describe, it } from "node:test";
import { type BenchRow, BenchStore, benchRow, logScale, quantile, score } from "../src/bench.ts";
import { loadConfig } from "../src/config.ts";
import type { Collector } from "../src/dash/collect.ts";
import { radar } from "../src/dash/bench.ts";
import { startDashboard } from "../src/dash/server.ts";
import { loadTasks } from "../src/evals.ts";
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
			row({ task: "fix", run: "2026-10-22", pass: false, badToolCalls: 2, retries: 2 }),
			row({ task: "where", kind: "locate", run: "2026-10-21" }),
			row({ task: "where", kind: "locate", run: "2026-10-22" }),
		];
		const s = score("gateway/a", rows);
		assert.equal(s.runs, 2);
		const cap = Object.fromEntries(s.capability.map((a) => [a.name, a]));
		assert.equal(cap.Coding!.score, 50);
		assert.equal(cap["Reasoning (finding bugs)"]!.score, 100);
		assert.equal(cap["Tool use"]!.score, 95, "2 bad calls in 40");
		assert.equal(cap.Consistency!.score, 50, "one of two tasks passed every time");
		assert.equal(cap["Cost efficiency"]!.value, "$0.067 a solved task");
		const ops = Object.fromEntries(s.operations.map((a) => [a.name, a]));
		assert.equal(ops["First token"]!.value, "1.0s");
		assert.equal(ops["Output speed"]!.value, "100 tokens/s");
		assert.equal(ops["Call success"]!.score, 94, "2 retries among 34 calls");
		assert.equal(ops["Task time"]!.value, "2.0m");
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

	it("is off unless SCOUT_BENCH_MODELS names models, and its tab only shows when it's on", async () => {
		const base = { SCOUT_REPO_URL: "x", SCOUT_REPO_SLUG: "o/r", SCOUT_CODEHOST_TOKEN: "t", SCOUT_CODEHOST_API: "http://f/api/v1" };
		assert.equal(loadConfig(base).bench, undefined);
		const on = loadConfig({ ...base, SCOUT_BENCH_MODELS: "gateway/lunaroute/beam, gateway/lunaroute/glm-5.3" }).bench!;
		assert.deepEqual(on.models, [{ provider: "gateway", modelId: "lunaroute/beam" }, { provider: "gateway", modelId: "lunaroute/glm-5.3" }]);
		assert.equal(on.hour, 1);
		assert.throws(() => loadConfig({ ...base, SCOUT_BENCH_MODELS: "beam" }), /should look like provider\/modelId/);

		const collector = { collect: async () => busy } as unknown as Collector;
		const off = await startDashboard({ addr: "127.0.0.1:0", collector });
		assert.equal((await get(off.port, "/bench")).status, 404);
		assert.doesNotMatch((await get(off.port, "/")).body, /Benchmark/);
		await off.close();

		const scores = [score("gateway/a", [row()]), score("gateway/b", [row({ model: "gateway/b", pass: false })])];
		const dash = await startDashboard({ addr: "127.0.0.1:0", collector, bench: () => ({ scores, lastRun: "2026-10-22", keep: 10, hour: 1, tasks: 7 }) });
		assert.match((await get(dash.port, "/")).body, /<nav class="tabs"><a href="\/" aria-current="page">Now<\/a><a href="\/bench">Benchmark<\/a><\/nav>/);
		const page = (await get(dash.port, "/bench")).body;
		assert.match(page, /7 tasks from Scout's own history/);
		assert.match(page, /<figcaption>What it can do<\/figcaption>/);
		assert.match(page, /<figcaption>Working with it<\/figcaption>/);
		assert.match(page, /<li class="s1"><i><\/i>gateway\/b/);
		assert.doesNotMatch(page, /<script|style=/, "nothing the dashboard's content security policy would block");
		const empty = await startDashboard({ addr: "127.0.0.1:0", collector, bench: () => ({ scores: [], keep: 10, hour: 1, tasks: 7 }) });
		assert.match((await get(empty.port, "/bench")).body, /No runs yet\. The first is tonight after 01:00\./);
		await dash.close();
		await empty.close();
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
