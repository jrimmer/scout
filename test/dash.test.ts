import assert from "node:assert/strict";
import { request } from "node:http";
import { describe, it } from "node:test";
import { Collector } from "../src/dash/collect.ts";
import { Grid } from "../src/dash/grid.ts";
import { layout } from "../src/dash/layout.ts";
import { hashPassword, startDashboard, verifyPassword } from "../src/dash/server.ts";
import { Memory } from "../src/memory.ts";
import { Pulls } from "../src/pulls.ts";
import { Threads, threadKey } from "../src/threads.ts";
import { busy } from "./fixtures/snapshot.ts";

describe("grid", () => {
	it("draws frames, meters and sparklines, and clips to its width", () => {
		const grid = new Grid(20);
		grid.box(0, 0, 20, 4, "panel");
		grid.meter(2, 1, 10, 0.5, { warn: 0.6, bad: 0.4, lowIsBad: true });
		grid.spark(2, 2, 4, [0, 1, 2, 4]);
		grid.put(14, 1, "toolong", "text", 4);
		assert.equal(
			grid.text(),
			["┌─ panel ──────────┐", "│ █████░░░░░  too… │", "│ ▁▂▄█             │", "└──────────────────┘"].join("\n"),
		);
	});

	it("keeps wide characters from breaking rows, and escapes HTML", () => {
		const grid = new Grid(12);
		grid.put(0, 0, "a🚩b<i>", "bad");
		assert.equal(grid.text(), "a·b<i>");
		assert.equal(grid.html(), '<span class="gr" id="r0"><span class="g-bad">a·b&lt;i&gt;</span>      </span>');
	});
});

describe("dashboard layout", () => {
	it("lays a busy afternoon out in fixed-width panels", () => {
		const text = layout(busy).text();
		const lines = text.split("\n");
		assert.ok(lines.every((line) => [...line].length <= 104), "nothing wider than the grid");
		assert.match(text, /needs a person[\s\S]*! profile pull failed/);
		assert.match(text, /▶ #checkout 12 steps bash npm test -- c…  2m 14s/);
		assert.match(text, /merged 7d   ████████████░░░░ 78% 7\/9/);
		assert.match(text, /\[15\] #data-team The orders table is partitioned by day/);
		assert.match(text, /✗ storefront Remove dead feature flag · ch…/);
		assert.match(text, /▶ team\/api#88 ffee001 +reviewing/);
	});

	it("says plainly when there is nothing yet", () => {
		const text = layout({
			...busy,
			alerts: [],
			working: [],
			threads: [],
			pulls: { ...busy.pulls, week: { merged: 0, closed: 0 }, latest: [] },
			learning: { ...busy.learning, profileRepo: false, notes: [] },
		}).text();
		assert.doesNotMatch(text, /needs a person|unreviewed notes ─/);
		assert.match(text, /· idle/);
		assert.match(text, /nobody has mentioned Scout yet/);
		assert.match(text, /merged 7d   nothing decided/);
		assert.match(text, /nightly reflection is off/);
	});
});

describe("collector", () => {
	it("reads Scout's stores and keeps a short history", async () => {
		const threads = new Threads(":memory:");
		const pulls = new Pulls(":memory:");
		const memory = new Memory(":memory:");
		threads.insert({ key: threadKey("C1", "1"), conversationId: 1, channel: "C1", threadTs: "1", startedBy: "U1" });
		pulls.opened({ url: "u", number: 1, slug: "o/r", kind: "work", conversationId: 1, title: "Fix" });
		memory.remember("team", "a note");
		let spent = 1;
		const collector = new Collector({
			host: "h",
			model: "m",
			startedAt: 0,
			reflectHour: 3,
			profileRepo: true,
			threads,
			pulls,
			memory,
			working: () => [{ conversationId: 1, startedAt: 0, steps: 3, lastStep: "bash ls" }],
			channelOf: async () => "team",
			spend: async () => ({ "p/m": spent }),
			alerts: () => [],
		});
		await collector.collect(1_000);
		spent = 2;
		const s = await collector.collect(3_601_000);
		assert.deepEqual(s.working, [{ channel: "team", startedAt: 0, steps: 3, lastStep: "bash ls" }]);
		assert.deepEqual(s.threads.map((t) => [t.channel, t.pulls, t.working]), [["team", 1, true]]);
		assert.equal(s.pulls.openNow, 1);
		assert.deepEqual(s.learning.notes.map((n) => n.note), ["a note"]);
		assert.deepEqual(s.history.working, [1, 1]);
		assert.deepEqual(s.history.spendPerHour, [1]);
		assert.equal(s.spend.total, 2);
		threads.close();
		pulls.close();
		memory.close();
	});
});

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
			let body = "";
			res.on("data", (chunk) => {
				body += chunk;
				if (path === "/stream" && body.includes("event: rows")) req.destroy();
			});
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
			res.on("close", () => resolve({ status: res.statusCode ?? 0, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

describe("dashboard server", () => {
	it("checks passwords against scrypt hashes", () => {
		const hash = hashPassword("hunter2");
		assert.equal(verifyPassword("hunter2", hash), true);
		assert.equal(verifyPassword("hunter3", hash), false);
		assert.equal(verifyPassword("hunter2", "plain"), false);
	});

	it("refuses to listen beyond loopback without a password", async () => {
		const collector = { collect: async () => busy } as unknown as Collector;
		await assert.rejects(startDashboard({ addr: "0.0.0.0:0", collector }), /needs SCOUT_DASH_USER/);
	});

	it("serves the grid behind basic auth, and streams only changed rows", async () => {
		let snapshot = busy;
		const collector = { collect: async () => snapshot } as unknown as Collector;
		const dash = await startDashboard({
			addr: "127.0.0.1:0",
			auth: { user: "ops", passwordHash: hashPassword("pw") },
			collector,
			intervalMs: 50,
		});
		const auth = { authorization: `Basic ${Buffer.from("ops:pw").toString("base64")}` };
		assert.equal((await get(dash.port, "/")).status, 401);
		assert.equal((await get(dash.port, "/healthz")).body, "ok");
		const page = await get(dash.port, "/", auth);
		assert.equal(page.status, 200);
		assert.match(page.body, /<pre id="grid" class="grid"><span class="gr" id="r0">/);
		assert.equal((await get(dash.port, "/static/../server.ts", auth)).status, 404);
		assert.equal((await get(dash.port, "/static/dash.js", auth)).status, 200);

		snapshot = { ...busy, threadsToday: 99 };
		const stream = await get(dash.port, "/stream", auth);
		assert.match(stream.body, /^event: grid\n/);
		const patch = stream.body.split("event: rows\ndata: ")[1]!.split("\n")[0]!;
		const rows = JSON.parse(patch) as { id: string; html: string }[];
		assert.ok(rows.some((r) => r.html.includes("99")), "the changed row");
		assert.ok(rows.length < 5, "and not the whole grid");
		await dash.close();
	});

	it("gives monitors the snapshot as JSON with the metrics token, and nobody else", async () => {
		const collector = { collect: async () => busy } as unknown as Collector;
		const dash = await startDashboard({
			addr: "127.0.0.1:0",
			auth: { user: "ops", passwordHash: hashPassword("pw") },
			collector,
			metrics: { token: "tok", render: async () => "scout_runs_total 1\n" },
		});
		assert.equal((await get(dash.port, "/status.json")).status, 401);
		assert.equal((await get(dash.port, "/status.json", { authorization: "Bearer nope" })).status, 401);
		const status = await get(dash.port, "/status.json", { authorization: "Bearer tok" });
		assert.equal(status.status, 200);
		assert.equal((JSON.parse(status.body) as { threadsToday: number }).threadsToday, busy.threadsToday);
		assert.equal((await get(dash.port, "/metrics", { authorization: "Bearer tok" })).body, "scout_runs_total 1\n");
		await dash.close();
	});
});
