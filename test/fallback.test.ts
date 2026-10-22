import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { limitModels, ModelBreakers, ModelLimiter } from "../src/capacity.ts";
import { loadConfig } from "../src/config.ts";
import { layout } from "../src/dash/layout.ts";
import { startDashboard } from "../src/dash/server.ts";
import type { Collector } from "../src/dash/collect.ts";
import { evalConfig } from "../src/evals.ts";
import { runJob } from "../src/job.ts";
import { SpendLedger } from "../src/limits.ts";
import { Pricing } from "../src/pricing.ts";
import { type ChatMessage, ThreadView } from "../src/render.ts";
import { openScout } from "../src/scout.ts";
import { busy } from "./fixtures/snapshot.ts";

const MINUTE = 60_000;
const PRIMARY = "gateway/lunaroute/deepseek-4.1-flash";
const FALLBACK = "gateway/lunaroute/glm-5.3";

function breakers(now: { t: number }, said: string[] = []) {
	return new ModelBreakers({ fallbacks: [FALLBACK], after: 3, forMs: 15 * MINUTE, say: (text) => said.push(text), now: () => now.t });
}

/** One call for `model` that ends `outcome`: where it went. */
function call(b: ModelBreakers, outcome: "ok" | "failed" | "neither", model = PRIMARY, session = "s"): string {
	const route = b.route(model, session);
	b.settle(route, outcome, outcome === "failed" ? '502: {"message":"upstream connect error"}' : undefined);
	return route.to;
}

describe("fallback models", () => {
	it("opens after the set number of failed calls in a row, and not when successes come between", () => {
		const now = { t: 0 };
		const said: string[] = [];
		const b = breakers(now, said);
		for (const outcome of ["failed", "failed", "ok", "failed", "failed", "neither"] as const) assert.equal(call(b, outcome), PRIMARY);
		assert.deepEqual(b.outages(), [], "an answer in between starts the count again, and a stop doesn't count");
		assert.equal(call(b, "failed"), PRIMARY);
		assert.deepEqual(b.outages(), [{ model: PRIMARY, fallback: FALLBACK, since: 0, retryAt: 15 * MINUTE, failures: 3, error: "upstream connect error" }]);
		assert.deepEqual(said, ["Heads up: deepseek-4.1-flash has failed 3 calls in a row (upstream connect error), so I'm using glm-5.3 for now. I'll try deepseek-4.1-flash again every 15 minutes."]);
		assert.equal(call(b, "ok", PRIMARY, "t1"), FALLBACK, "its calls go to the fallback");
		assert.equal(b.notice("t1"), "deepseek-4.1-flash isn't answering, so I'm using glm-5.3 for now.");
		assert.equal(b.notice("t2"), undefined, "only threads whose calls went there say so");
	});

	it("tries the model again after a while: an answer closes it, a failure gives it another while", () => {
		const now = { t: 0 };
		const said: string[] = [];
		const b = breakers(now, said);
		for (let i = 0; i < 3; i++) call(b, "failed");
		now.t = 15 * MINUTE;
		const probe = b.route(PRIMARY, "t1");
		assert.deepEqual(probe, { to: PRIMARY, probe: true });
		assert.equal(b.route(PRIMARY, "t2").to, FALLBACK, "one call tries it; the others stay on the fallback meanwhile");
		b.settle(probe, "failed", "503 service unavailable");
		assert.equal(b.outages()[0]?.retryAt, 30 * MINUTE, "failed again: another 15 minutes");
		assert.equal(call(b, "ok", PRIMARY, "t1"), FALLBACK);
		now.t = 30 * MINUTE;
		assert.equal(call(b, "ok", PRIMARY, "t1"), PRIMARY, "the next try answers");
		assert.deepEqual(b.outages(), []);
		assert.equal(b.notice("t1"), undefined);
		assert.equal(said.length, 1, "back isn't said until it has stayed up a while");

		// It fails again straight away: nobody heard it was back, so nobody hears it's down again.
		for (let i = 0; i < 3; i++) call(b, "failed");
		assert.equal(said.length, 1);
		now.t = 45 * MINUTE;
		call(b, "ok");
		now.t = 56 * MINUTE;
		call(b, "ok");
		assert.deepEqual(said.slice(1), ["deepseek-4.1-flash is answering again, so I'm back on it. It was out for about 45 minutes."]);
	});

	it("passes over a fallback that's failing too, and keeps trying its own model when nothing answers", () => {
		const now = { t: 0 };
		const said: string[] = [];
		const b = new ModelBreakers({ fallbacks: [FALLBACK, "anthropic/claude-haiku-5-5"], after: 1, forMs: 15 * MINUTE, say: (text) => said.push(text), now: () => now.t });
		call(b, "failed");
		assert.equal(call(b, "failed", PRIMARY), FALLBACK);
		assert.equal(call(b, "failed", PRIMARY), "anthropic/claude-haiku-5-5");
		assert.equal(call(b, "failed", PRIMARY), PRIMARY);
		assert.match(said.at(-1)!, /claude-haiku-5-5 has failed 1 calls in a row \(upstream connect error\), and none of my fallback models are answering either/);
	});

	it("sends a failing model's calls to the fallback, answered and priced as the fallback", async () => {
		const now = { t: 0 };
		const failing = new Set(["deepseek-4.1-flash"]);
		const models = {
			getModel: (provider: string, id: string) => ({ api: "openai-completions", provider, id }),
			streamSimple: (model: { api: string; provider: string; id: string }) => {
				const stream = createAssistantMessageEventStream();
				if (model.id.endsWith("thrown")) throw new Error("socket hang up");
				const down = failing.has(model.id.split("/").pop()!);
				const message = {
					role: "assistant",
					content: down ? [] : [{ type: "text", text: `${model.id} here` }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 1_000_000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					stopReason: down ? "error" : "stop",
					...(down ? { errorMessage: "502 bad gateway" } : {}),
					timestamp: 0,
				};
				setTimeout(() => (down ? stream.push({ type: "error", reason: "error", error: message } as never) : stream.push({ type: "done", reason: "stop", message } as never)), 1);
				return stream;
			},
		} as unknown as Models;
		const said: string[] = [];
		const b = new ModelBreakers({ fallbacks: [FALLBACK], after: 2, forMs: 15 * MINUTE, say: (text) => said.push(text), now: () => now.t });
		const limited = limitModels(models, new ModelLimiter({ max: 0 }), undefined, b);
		const primary = { api: "openai-completions", provider: "gateway", id: "lunaroute/deepseek-4.1-flash" } as never;
		const ask = () => limited.streamSimple(primary, { messages: [] }, { sessionId: "s1" }).result();
		assert.equal((await ask()).stopReason, "error");
		assert.equal((await ask()).stopReason, "error");
		const answered: AssistantMessage = await ask();
		assert.equal(answered.stopReason, "stop");
		assert.equal(`${answered.provider}/${answered.model}`, FALLBACK, "the answer says which model gave it");
		assert.equal(b.notice("s1"), "deepseek-4.1-flash isn't answering, so I'm using glm-5.3 for now.");
		assert.equal(said.length, 1);

		const pricing = new Pricing({ [PRIMARY]: { input: 1, output: 1 }, [FALLBACK]: { input: 3, output: 1 } });
		const ledger = new SpendLedger(":memory:", pricing);
		ledger.responded({ conversationId: 1, channel: "web", message: answered });
		assert.deepEqual(ledger.byModel(0), { [FALLBACK]: 3 }, "spend is the fallback's, at its price");
		ledger.close();

		// A call that throws counts as a failure too.
		const thrown = { ...(primary as object), id: "thrown" } as never;
		const t = new ModelBreakers({ fallbacks: [FALLBACK], after: 1, forMs: MINUTE, now: () => now.t });
		const result = await limitModels(models, new ModelLimiter({ max: 0 }), undefined, t).streamSimple(thrown, { messages: [] }, { sessionId: "s2" }).result();
		assert.equal(result.errorMessage, "socket hang up");
		assert.equal(t.outages()[0]?.model, "gateway/thrown");
	});

	it("is off unless SCOUT_FALLBACK_MODELS names models, and the gateway knows the ones it serves", () => {
		const base = { SCOUT_REPO_URL: "x", SCOUT_REPO_SLUG: "o/r", SCOUT_CODEHOST_TOKEN: "t", SCOUT_CODEHOST_API: "http://f/api/v1" };
		assert.equal(loadConfig({ ...base, SCOUT_FALLBACK_AFTER: "5" }).fallback, undefined);
		const on = loadConfig({ ...base, SCOUT_MODEL: PRIMARY, SCOUT_GATEWAY_URL: "http://gw", SCOUT_FALLBACK_MODELS: `${FALLBACK}, anthropic/claude-haiku-5-5` });
		assert.deepEqual(on.fallback, {
			models: [
				{ provider: "gateway", modelId: "lunaroute/glm-5.3" },
				{ provider: "anthropic", modelId: "claude-haiku-5-5" },
			],
			after: 3,
			minutes: 15,
		});
		assert.deepEqual(on.gateway?.models, ["lunaroute/deepseek-4.1-flash", "lunaroute/glm-5.3"]);
		assert.equal(evalConfig(on, { repos: [], profileDir: "p", apiUrl: "http://h", dataDir: "d" }).fallback, undefined, "evals and the benchmark measure their own model");
		assert.deepEqual(loadConfig({ ...base, SCOUT_FALLBACK_MODELS: FALLBACK, SCOUT_FALLBACK_AFTER: "2", SCOUT_FALLBACK_FOR: "5" }).fallback?.after, 2);
		assert.throws(() => loadConfig({ ...base, SCOUT_FALLBACK_MODELS: "glm-5.3" }), /SCOUT_FALLBACK_MODELS: "glm-5.3" should look like provider\/modelId/);
		assert.throws(() => loadConfig({ ...base, SCOUT_FALLBACK_MODELS: "anthropic/claude-opus-5-5" }), /names SCOUT_MODEL/);
		assert.throws(() => loadConfig({ ...base, SCOUT_FALLBACK_MODELS: FALLBACK, SCOUT_FALLBACK_AFTER: "0" }), /SCOUT_FALLBACK_AFTER must be a whole number of at least 1/);
		assert.throws(() => loadConfig({ ...base, SCOUT_FALLBACK_MODELS: FALLBACK, SCOUT_FALLBACK_FOR: "soon" }), /SCOUT_FALLBACK_FOR must be a whole number/);
	});

	it("runs on the fallback in a real run, records its spend at its price, and refuses a fallback that doesn't exist", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "scout-fallback-")));
		mkdirSync(join(root, "profile"));
		writeFileSync(join(root, "prices.json"), JSON.stringify({ "faux/m": { input: 1, output: 1 }, "faux/f": { input: 1_000_000, output: 0 } }));
		const env = {
			SCOUT_MODEL: "faux/m",
			SCOUT_FALLBACK_MODELS: "faux/f",
			SCOUT_PRICES_FILE: join(root, "prices.json"),
			SCOUT_REPO_URL: join(root, "nowhere.git"),
			SCOUT_REPO_SLUG: "o/r",
			SCOUT_CODEHOST_TOKEN: "t",
			SCOUT_CODEHOST_API: "http://forge/api/v1",
			SCOUT_DATA_DIR: join(root, "data"),
			SCOUT_PROFILE_DIR: join(root, "profile"),
		};
		const config = loadConfig(env);
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }, { id: "f" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const said: string[] = [];
		const scout = await openScout({ config, storage: new MemoryStorage(), dataDir: config.dataDir, instance: "f", context, models, watchProfile: false, announce: (text) => said.push(text) });
		for (let i = 0; i < 3; i++) scout.breakers!.settle(scout.breakers!.route("faux/m", "other"), "failed", "503 service unavailable");
		assert.match(said[0]!, /^Heads up: m has failed 3 calls in a row \(503 service unavailable\), so I'm using f for now\./);

		faux.setResponses([(_context, _options, _state, model) => fauxAssistantMessage(`answered by ${model.id}`)]);
		const result = await runJob(scout, "what's up?", { progress: () => {} });
		assert.deepEqual(result, { ok: true, answer: "answered by f", pullRequests: [] });
		const spent = scout.spend.byModel(0);
		assert.deepEqual(Object.keys(spent), ["faux/f"]);
		assert.ok(spent["faux/f"]! > 0, "priced at the fallback's price");
		await scout.close();

		const wrong = loadConfig({ ...env, SCOUT_FALLBACK_MODELS: "faux/nope", SCOUT_DATA_DIR: join(root, "data2") });
		await assert.rejects(openScout({ config: wrong, storage: new MemoryStorage(), dataDir: wrong.dataDir, instance: "g", context, models, watchProfile: false }), /SCOUT_FALLBACK_MODELS: there's no model faux\/nope/);
	});

	it("says once in a run's message that it's on the fallback, and keeps it with the answer", async () => {
		const posted: ChatMessage[] = [];
		const surface = {
			post: async (_c: string, _t: string | undefined, m: ChatMessage) => (posted.push(m), "1.1"),
			update: async (_c: string, _ts: string, m: ChatMessage) => void posted.push(m),
		};
		let asked = 0;
		let onFallback = true;
		const view = new ThreadView({
			surface,
			channel: "C",
			threadTs: "1",
			fallback: async () => (asked++, onFallback ? "deepseek-4.1-flash isn't answering, so I'm using glm-5.3 for now." : undefined),
		});
		const said = (text: string) => ({ type: "message_end", entry: { model: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }] } }) as never;
		view.handle([{ type: "run_start", inputs: [] }]);
		view.handle([said("Looking."), said("Found it.")]);
		view.handle([{ type: "message_end", entry: { model: [{ role: "user", content: "more" }] } } as never]);
		view.handle([{ type: "run_end", inputs: [] }]);
		await view.settled();
		const final = JSON.stringify(posted.at(-1)!.blocks);
		assert.match(final, /"text":"deepseek-4\.1-flash isn't answering, so I'm using glm-5\.3 for now\."/);
		assert.equal(final.match(/isn't answering/g)?.length, 1, "once");
		assert.equal(asked, 1, "asked once a run, after a model's answer");

		onFallback = false;
		view.handle([{ type: "run_start", inputs: [] }, said("Back to normal.")]);
		view.handle([{ type: "run_end", inputs: [] }]);
		await view.settled();
		assert.doesNotMatch(JSON.stringify(posted.at(-1)!.blocks), /isn't answering/, "a new run asks again");
	});

	it("shows on the dashboard and in /status.json which model is answering", async () => {
		const now = busy.now;
		const calm = layout({ ...busy, models: { primary: PRIMARY, fallbacks: [FALLBACK], outages: [] } }).text();
		assert.match(calm, /model {8}deepseek-4\.1-flash {2}· falls back to glm-5\.3/);
		const since = new Date(now - 40 * MINUTE);
		const hhmm = [since.getHours(), since.getMinutes()].map((n) => String(n).padStart(2, "0")).join(":");
		const down = { ...busy, models: { primary: PRIMARY, fallbacks: [FALLBACK], outages: [{ model: PRIMARY, fallback: FALLBACK, since: now - 40 * MINUTE, retryAt: now + 12 * MINUTE, failures: 3, error: "upstream connect error" }] } };
		const text = layout(down).text();
		assert.ok(text.split("\n").every((line) => [...line].length <= 104));
		assert.match(text, /model {8}deepseek-4\.1-flash failing/);
		assert.match(text, new RegExp(`fallback {5}glm-5\\.3 since ${hhmm} \\(deepseek-4\\.1-flash failing: upstream connect error\\) +retry in 12m`));
		assert.doesNotMatch(layout(busy).text(), /falls back to/, "nothing without the models");

		const dash = await startDashboard({ addr: "127.0.0.1:0", collector: { collect: async () => down } as unknown as Collector, metrics: { token: "tok", render: async () => "" } });
		const response = await fetch(`http://127.0.0.1:${dash.port}/status.json`, { headers: { authorization: "Bearer tok" } });
		const status = (await response.json()) as typeof down;
		assert.deepEqual(status.models, down.models);
		await dash.close();
	});
});
