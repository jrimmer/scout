import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Models } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { aboutHowLong, Capacity, limitModels, minutes, ModelLimiter, WaitBoard } from "../src/capacity.ts";
import { Limits, SpendLedger } from "../src/limits.ts";
import { Pricing } from "../src/pricing.ts";
import { ProgressPacer, progressMessage } from "../src/render.ts";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const NOW = Date.parse("2026-10-21T12:00:00Z");

describe("what to tell people about waiting", () => {
	it("gives an ETA as a range from how long runs take, and none until it has something to go on", () => {
		const capacity = new Capacity(":memory:");
		assert.equal(capacity.eta(2, 8, NOW), undefined, "no runs yet: no guess");
		for (const m of [2, 3, 4, 5, 8]) capacity.ran(m * MINUTE, NOW - m * MINUTE);
		const range = capacity.eta(16, 8, NOW)!;
		assert.ok(range.low < range.high);
		assert.equal(aboutHowLong(range), "about 3–10 minutes", "two rounds of runs ahead, from the quicker to the slower quartile");
		assert.equal(aboutHowLong({ low: 0, high: 50_000 }), "under a minute");
		assert.equal(aboutHowLong({ low: 30_000, high: 100_000 }), "a minute or two");
		assert.equal(minutes(45_000), "45 seconds");
		assert.equal(minutes(3 * MINUTE), "3 minutes");
		capacity.close();
	});

	it("tells whoever runs Scout when waiting has become common, with what would help, once a day", () => {
		const capacity = new Capacity(":memory:");
		const settings = { maxRuns: 8, maxModelCalls: 6 };
		for (let i = 0; i < 10; i++) capacity.ran(4 * MINUTE, NOW - i * MINUTE);
		capacity.waited("run", 30_000, NOW - 5 * MINUTE);
		assert.equal(capacity.notice(settings, NOW), undefined, "one short wait isn't a trend");
		for (let i = 0; i < 3; i++) capacity.waited("run", (2 + i) * MINUTE, NOW - i * MINUTE);
		const notice = capacity.notice(settings, NOW)!;
		assert.match(notice, /^Heads up: people have been waiting on me more than they should\./);
		assert.match(notice, /3 of 10 requests in the last day waited over a minute for their turn \(half waited over 3 minutes/);
		assert.match(notice, /raise SCOUT_MAX_RUNS \(it's 8\)/);
		assert.equal(capacity.notice(settings, NOW + MINUTE), undefined, "once a day");
		for (let i = 0; i < 3; i++) capacity.waited("run", 2 * MINUTE, NOW + DAY - i * MINUTE);
		for (let i = 0; i < 5; i++) capacity.ran(4 * MINUTE, NOW + DAY - i * MINUTE);
		assert.notEqual(capacity.notice(settings, NOW + DAY + MINUTE), undefined, "and again the next day if it still holds");
		assert.match(capacity.weekLine(NOW + DAY)!, /^Waiting last week: 7 requests waited for their turn/);
		assert.equal(new Capacity(":memory:").weekLine(NOW), undefined);
		capacity.close();
	});

	it("knows who's waiting on what right now", () => {
		const board = new WaitBoard();
		board.start("sandbox", "t-1", 1_000);
		board.start("sandbox", "t-1", 2_000);
		assert.equal(board.since("sandbox", "t-1"), 1_000, "since it first started waiting");
		assert.equal(board.count("sandbox"), 1);
		assert.equal(board.end("sandbox", "t-1", 5_000), 4_000);
		assert.equal(board.since("sandbox", "t-1"), undefined);
	});
});

describe("model calls take turns", () => {
	it("lets at most the limit through at once, in order, and says where a waiting call is in line", async () => {
		const waited: number[] = [];
		const limiter = new ModelLimiter({ max: 2, onWaited: (ms) => waited.push(ms) });
		const a = await limiter.acquire("a");
		const b = await limiter.acquire("b");
		let cStarted = false;
		const c = limiter.acquire("c").then((release) => {
			cStarted = true;
			return release;
		});
		const stop = new AbortController();
		const d = limiter.acquire("d", stop.signal);
		const e = limiter.acquire("e");
		await Promise.resolve();
		assert.equal(limiter.inFlight, 2);
		assert.deepEqual([limiter.position("c"), limiter.position("d"), limiter.position("e"), limiter.position("a")], [1, 2, 3, undefined]);
		stop.abort();
		await d;
		assert.equal(limiter.position("e"), 2, "a stopped run gives up its place");
		a();
		a();
		const release = await c;
		assert.equal(cStarted, true);
		assert.equal(limiter.inFlight, 2, "releasing twice frees one slot, not two");
		b();
		(await e)();
		release();
		assert.equal(waited.length, 2, "the stopped call's wait isn't a wait anyone sat through");
	});

	it("holds streamed calls before they start, so the provider never sees more than the limit", async () => {
		let running = 0;
		let most = 0;
		const message = { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" };
		const models = {
			streamSimple: () => {
				const stream = createAssistantMessageEventStream();
				running++;
				most = Math.max(most, running);
				setTimeout(() => {
					running--;
					stream.push({ type: "done", reason: "stop", message } as never);
				}, 5);
				return stream;
			},
			getModel: () => "passed through",
		} as unknown as Models;
		const limited = limitModels(models, new ModelLimiter({ max: 2 }));
		const model = { api: "x", provider: "p", id: "m" } as never;
		const results = await Promise.all(Array.from({ length: 6 }, (_, i) => limited.streamSimple(model, { messages: [] }, { sessionId: `s${i}` }).result()));
		assert.equal(results.length, 6);
		assert.equal(most, 2);
		assert.equal((limited as unknown as { getModel: () => string }).getModel(), "passed through");
		assert.equal(limitModels(models, new ModelLimiter({ max: 0 })), models, "0: no limit, the models as they are");
	});
});

describe("run limits", () => {
	it("knows how many more runs could start, in all and in a channel", () => {
		const pricing = new Pricing();
		const limits = new Limits({ concurrency: { total: 8, perChannel: 3 } }, new SpendLedger(":memory:", pricing), pricing);
		const working = [{ channel: "web" }, { channel: "web" }, { channel: "api" }];
		assert.equal(limits.free("web", working), 1);
		assert.equal(limits.free("api", working), 2);
		assert.equal(limits.free("ops", [...working, ...Array.from({ length: 5 }, () => ({ channel: "x" }))]), 0);
		assert.equal(new Limits({}, new SpendLedger(":memory:", pricing), pricing).free("web", working), Number.POSITIVE_INFINITY);
	});
});

describe("progress edits, paced across the workspace", () => {
	function paced() {
		let now = 0;
		const sent: string[] = [];
		const pacer = new ProgressPacer({ now: () => now, later: () => {} });
		return {
			pacer,
			sent,
			at: (ms: number) => {
				now = ms;
				pacer.tick();
			},
			want: (key: string, state: string) => pacer.want(key, () => sent.push(`${key}:${state}`)),
		};
	}

	it("keeps the total under one edit a second however many threads work, sending only each one's latest state", () => {
		const p = paced();
		for (let i = 0; i < 20; i++) p.want(`t${i}`, "a");
		for (let ms = 0; ms <= 10_000; ms += 100) p.at(ms);
		assert.equal(p.sent.length, 11, "one edit a second, not twenty at once");
		p.want("t0", "b");
		p.want("t0", "c");
		for (let ms = 10_100; ms <= 30_000; ms += 100) p.at(ms);
		assert.ok(p.sent.includes("t0:c") && !p.sent.includes("t0:b"), "only the latest state of a message goes out");
		assert.equal(new Set(p.sent).size, p.sent.length, "nothing sent twice");
	});

	it("lets a few threads update every second and a half, and drops a thread's waiting edit when its answer goes out", () => {
		const p = paced();
		p.want("t1", "a");
		p.at(0);
		p.want("t1", "b");
		p.at(1_000);
		assert.deepEqual(p.sent, ["t1:a"], "not again within 1.5 s");
		p.at(1_500);
		assert.deepEqual(p.sent, ["t1:a", "t1:b"]);
		p.want("t1", "c");
		p.pacer.cancel("t1");
		p.at(5_000);
		assert.deepEqual(p.sent, ["t1:a", "t1:b"], "the answer replaced it: no stale progress after it");
	});

	it("says what a run is waiting on ahead of anything else", () => {
		const text = (progressMessage({ startedAt: 0, steps: [], status: "Still thinking…", waiting: "Waiting my turn for the model: I'm next." }, 5_000).blocks[0] as { text: string }).text;
		assert.match(text, /^_Working… 5s_\n_Waiting my turn for the model: I'm next\._/);
	});
});
