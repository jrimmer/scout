import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, type Storage, type ToolExecutionApi } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { limitModels, ModelLimiter } from "../src/capacity.ts";
import { drain } from "../src/drain.ts";
import { reviewAsSubtask } from "../src/review.ts";

const MODEL = { provider: "faux", modelId: "m" };

async function until(check: () => boolean, ms = 5000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** A gate a test opens when it's ready. */
function gate() {
	let open = () => {};
	const opened = new Promise<void>((resolve) => (open = resolve));
	return { open, opened };
}

describe("draining for a restart", () => {
	it("holds new model calls and lets the ones running finish", async () => {
		const limiter = new ModelLimiter({ max: 2 });
		const running = await limiter.acquire("a");
		limiter.drain((session) => session === "child");
		let held = false;
		const next = limiter.acquire("b").then((release) => {
			held = true;
			return release;
		});
		const child = await limiter.acquire("child");
		await Promise.resolve();
		assert.equal(held, false, "a new call waits");
		assert.equal(limiter.inFlight, 2, "the running call, and the call a running tool waits on");
		running();
		child();
		await Promise.resolve();
		assert.equal(held, false, "freed slots don't let it go");
		assert.equal(limiter.inFlight, 0);
		assert.equal(limiter.waiting, 1);
		const stop = new AbortController();
		const stopped = limiter.acquire("c", stop.signal);
		stop.abort();
		(await stopped)();
		assert.equal(limiter.inFlight, 0, "a held call stopped by the close takes no slot");
		void next;
	});

	it("waits for the current step, then lets messages that came meanwhile run after the restart", async () => {
		const dir = mkdtempSync(join(tmpdir(), "scout-drain-"));
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		let ran = 0;
		const started = gate();
		let finish = gate();
		const slow = defineTool({
			name: "slow",
			description: "Takes a while",
			parameters: Type.Object({}),
			execute: async () => {
				ran++;
				started.open();
				await finish.opened;
				return { output: [{ type: "text", text: "slow is done" }] };
			},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "slow", tools: [slow] }));
		const open = async (storage: Storage, limiter: ModelLimiter) => Harness.open(storage, { models: limitModels(models, limiter), registry }, context);

		let calls = 0;
		faux.setResponses([
			() => {
				calls++;
				return fauxAssistantMessage([fauxToolCall("slow", {})], { stopReason: "toolUse" });
			},
		]);
		const limiter = new ModelLimiter({ max: 4 });
		let harness = await open(await openNodeSqliteStorage(join(dir, "pi.sqlite")), limiter);
		const a = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: MODEL } }, context);
		const asked = await a.submit({ type: "input", content: "do the slow thing", requestId: "a" }, context);
		await started.opened;

		let drained = false;
		const draining = drain({ harness, limiter, context, maxMs: 10_000, settleMs: 100, pollMs: 20 }).finally(() => (drained = true));
		// A message arrives while it drains: stored, its model call held.
		const b = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: MODEL } }, context);
		const meanwhile = await b.submit({ type: "input", content: "and this, please", requestId: "b" }, context);
		await until(() => limiter.waiting === 1);
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(drained, false, "the tool call is still running");
		finish.open();
		assert.equal((await draining).idle, true);
		assert.equal(calls, 1, "no model call started after the drain began");
		assert.equal(limiter.waiting, 2, "the first run's next step and the new message wait");
		await harness.close(context);

		// The next process: both runs carry on, and the tool call that finished isn't run again.
		const answers: string[] = [];
		faux.setResponses(
			[0, 1].map(() => (transcript: { messages: { role: string; content: unknown }[] }) => {
				calls++;
				const last = JSON.stringify(transcript.messages.at(-1)?.content);
				answers.push(last.includes("slow is done") ? "after the tool" : last.includes("and this") ? "the new message" : last);
				return fauxAssistantMessage("done");
			}),
		);
		finish = gate();
		harness = await open(await openNodeSqliteStorage(join(dir, "pi.sqlite")), new ModelLimiter({ max: 4 }));
		harness.resume();
		const again = [await harness.submission(asked.id, context), await harness.submission(meanwhile.id, context)];
		const settled = await Promise.all(again.map((s) => s!.wait(context)));
		assert.deepEqual(settled.map((s) => s.status), ["done", "done"]);
		assert.deepEqual(answers.sort(), ["after the tool", "the new message"]);
		assert.equal(ran, 1);
		assert.equal(calls, 3);
		await harness.close(context);
	});

	it("waits for a model call that's answering, and keeps its answer", async () => {
		const dir = mkdtempSync(join(tmpdir(), "scout-drain-"));
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const asked = gate();
		const answer = gate();
		faux.setResponses([
			async () => {
				asked.open();
				await answer.opened;
				return fauxAssistantMessage("here you go");
			},
		]);
		const limiter = new ModelLimiter({ max: 4 });
		const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "pi.sqlite")), { models: limitModels(models, limiter), registry: createRegistry() }, context);
		const a = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: MODEL } }, context);
		const submission = await a.submit({ type: "input", content: "hi", requestId: "a" }, context);
		await asked.opened;
		let drained = false;
		const draining = drain({ harness, limiter, context, maxMs: 5_000, settleMs: 100, pollMs: 20 }).finally(() => (drained = true));
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(drained, false);
		answer.open();
		assert.equal((await draining).idle, true);
		assert.equal((await submission.wait(context)).status, "done");
		await harness.close(context);
	});

	it("lets the model calls a running tool waits on go ahead, so the tool can finish", async () => {
		const dir = mkdtempSync(join(tmpdir(), "scout-drain-"));
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const go = gate();
		const reviewed: string[] = [];
		const review = defineTool({
			name: "review",
			description: "Has the change reviewed",
			parameters: Type.Object({}),
			execute: async (_args, api: ToolExecutionApi, ctx) => {
				await go.opened;
				const verdict = await reviewAsSubtask(api, { agent: { model: MODEL }, workspace: { root: dir, cwd: dir }, prompt: "review this", requestId: "review:1" }, ctx);
				reviewed.push(verdict.verdict);
				return { output: [{ type: "text", text: `review: ${verdict.verdict}` }] };
			},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "review", tools: [review] }));
		const limiter = new ModelLimiter({ max: 4 });
		const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "pi.sqlite")), { models: limitModels(models, limiter), registry }, context);
		faux.setResponses([fauxAssistantMessage([fauxToolCall("review", {})], { stopReason: "toolUse" }), fauxAssistantMessage("APPROVE")]);
		const a = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: MODEL } }, context);
		await a.submit({ type: "input", content: "open it", requestId: "a" }, context);
		await until(() => faux.getPendingResponseCount() === 1);

		const draining = drain({ harness, limiter, context, maxMs: 5_000, settleMs: 100, pollMs: 20 });
		go.open();
		const result = await draining;
		assert.equal(result.idle, true, "it didn't wait out the cap");
		assert.deepEqual(reviewed, ["approve"]);
		assert.equal(limiter.waiting, 1, "the run's next step waits for the restart");
		await harness.close(context);
	});

	it("stops waiting at the cap, with what was still going", async () => {
		const dir = mkdtempSync(join(tmpdir(), "scout-drain-"));
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const started = gate();
		const forever = defineTool({
			name: "forever",
			description: "Never ends",
			parameters: Type.Object({}),
			execute: (_args, _api, ctx) => {
				started.open();
				return new Promise((_resolve, reject) => ctx.abortSignal?.addEventListener("abort", () => reject(new Error("stopped"))));
			},
		});
		const registry = createRegistry();
		registry.install(defineExtension({ name: "forever", tools: [forever] }));
		const limiter = new ModelLimiter({ max: 4 });
		const harness = await Harness.open(await openNodeSqliteStorage(join(dir, "pi.sqlite")), { models: limitModels(models, limiter), registry }, context);
		faux.setResponses([fauxAssistantMessage([fauxToolCall("forever", {})], { stopReason: "toolUse" })]);
		const a = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: MODEL } }, context);
		await a.submit({ type: "input", content: "go", requestId: "a" }, context);
		await started.opened;
		const result = await drain({ harness, limiter, context, maxMs: 300, settleMs: 100, pollMs: 20 });
		assert.equal(result.idle, false);
		assert.equal(result.toolCalls, 1);
		assert.ok(result.ms >= 300);
		await harness.close(context);
	});
});
