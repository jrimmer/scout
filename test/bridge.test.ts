import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Type } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { Bridge, DECLINE_PRIVATE, type IncomingMessage } from "../src/bridge.ts";
import { loadProfile, profileExtension } from "../src/profile.ts";
import { ThreadSearch } from "../src/search.ts";
import type { ChatMessage, ChatSurface } from "../src/render.ts";
import { threadKey, Threads } from "../src/threads.ts";

const BOT = "UBOT";

type Sent = { op: "post" | "update"; channel: string; ref?: string; message: ChatMessage };

class FakeSurface implements ChatSurface {
	sent: Sent[] = [];
	#ts = 0;
	async post(channel: string, threadTs: string | undefined, message: ChatMessage) {
		this.sent.push({ op: "post", channel, ...(threadTs === undefined ? {} : { ref: threadTs }), message });
		return `9000.${++this.#ts}`;
	}
	async update(channel: string, ts: string, message: ChatMessage) {
		this.sent.push({ op: "update", channel, ref: ts, message });
	}
	texts(): string[] {
		return this.sent.map((s) => s.message.blocks.map((b) => (b as { text?: unknown }).text).join("\n"));
	}
}

async function until(check: () => boolean, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("bridge", () => {
	let harness: Harness;
	let threads: Threads;
	let surface: FakeSurface;
	let bridge: Bridge;
	let faux: ReturnType<typeof fauxProvider>;
	let search: ThreadSearch;

	const message = (overrides: Partial<IncomingMessage>): IncomingMessage => ({
		channel: "C1",
		channelType: "channel",
		channelName: "team",
		user: "UANN",
		text: `<@${BOT}> what does the build do?`,
		ts: "100.1",
		...overrides,
	});

	beforeEach(async () => {
		faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const profileDir = mkdtempSync(join(tmpdir(), "scout-profile-"));
		writeFileSync(join(profileDir, "system.md"), "You are Scout.");
		mkdirSync(join(profileDir, "channels", "team"), { recursive: true });
		writeFileSync(join(profileDir, "channels", "team", "instructions.md"), "We use pnpm.");
		const registry = createRegistry();
		registry.install(profileExtension(loadProfile(profileDir), { repo: async () => ({ name: "r", base: "main" }), branch: (id) => `scout/t-${id}` }));
		// A tool that works until it is stopped.
		const wait = defineTool({
			name: "wait",
			description: "Wait",
			parameters: Type.Object({}),
			execute: (_args, _api, ctx) =>
				new Promise((_resolve, reject) => ctx.abortSignal?.addEventListener("abort", () => reject(new Error("stopped")))),
		});
		registry.install(defineExtension({ name: "wait", tools: [wait] }));
		harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
		threads = new Threads(":memory:");
		surface = new FakeSurface();
		search = new ThreadSearch(":memory:");
		bridge = new Bridge({
			harness,
			threads,
			surface,
			botUserId: BOT,
			nameOf: async (user) => (user === "UANN" ? "ann" : "bob"),
			agent: { model: { provider: "faux", modelId: "faux-model" } },
			context,
			search,
		});
	});

	afterEach(async () => {
		await harness.close(context);
		threads.close();
	});

	async function settle(conversationId: number) {
		await harness.waitForIdle(context);
		await until(() => bridge.view(conversationId)?.busy === false);
		await bridge.view(conversationId)?.settled();
	}

	it("starts a thread on a mention and answers in one message", async () => {
		faux.setResponses([fauxAssistantMessage("It runs the tests.")]);
		await bridge.onMessage(message({}));
		const thread = threads.get(threadKey("C1", "100.1"));
		assert.ok(thread);
		await settle(thread.conversationId);

		assert.deepEqual(
			surface.sent.map((s) => [s.op, s.ref]),
			[
				["post", "100.1"],
				["update", "9000.1"],
			],
		);
		assert.match(surface.texts()[1] ?? "", /It runs the tests\./);
		assert.equal(threads.get(thread.key)?.lastSpeaker, "scout");
		assert.equal(threads.get(thread.key)?.runs, 1);
		await until(() => search.search("tests").length > 0);
		assert.deepEqual(search.search("build").map((h) => [h.key, h.speaker, h.channelName]), [["C1:100.1", "ann", "team"]]);
	});

	it("puts the speaker and the channel's instructions in front of the model", async () => {
		let seen = "";
		faux.setResponses([
			(transcript) => {
				seen = JSON.stringify(transcript);
				return fauxAssistantMessage("ok");
			},
		]);
		await bridge.onMessage(message({}));
		await settle(threads.get(threadKey("C1", "100.1"))!.conversationId);
		assert.match(seen, /ann: @Scout what does the build do\?/);
		assert.match(seen, /We use pnpm\./);
		assert.match(seen, /You are Scout\./);
	});

	it("answers a reply that follows Scout, but only notes people talking to each other", async () => {
		faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
		await bridge.onMessage(message({}));
		const thread = threads.get(threadKey("C1", "100.1"))!;
		await settle(thread.conversationId);

		await bridge.onMessage(message({ text: "and the lint step?", ts: "100.2", threadTs: "100.1" }));
		await settle(thread.conversationId);
		assert.equal(faux.state.callCount, 2);

		// Right after Scout answered ann, bob talks to ann: that is not for Scout.
		await bridge.onMessage(message({ user: "UBOB", text: "ann, lunch?", ts: "100.3", threadTs: "100.1" }));
		await bridge.onMessage(message({ text: "sure", ts: "100.4", threadTs: "100.1" }));
		await harness.waitForIdle(context);
		assert.equal(faux.state.callCount, 2, "no reply to a conversation between people");
		assert.equal(threads.get(thread.key)?.lastSpeaker, "UANN");

		// The side conversation is still context the next time someone asks.
		let seen = "";
		faux.setResponses([
			(transcript) => {
				seen = JSON.stringify(transcript);
				return fauxAssistantMessage("third");
			},
		]);
		await bridge.onMessage(message({ user: "UBOB", text: `<@${BOT}> summarize`, ts: "100.5", threadTs: "100.1" }));
		await settle(thread.conversationId);
		assert.match(seen, /bob: ann, lunch\?/);
		assert.match(seen, /ann: sure/);
	});

	for (const how of ["message", "reaction"] as const) {
		it(`stops running work by ${how}`, async () => {
			faux.setResponses([fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" })]);
			await bridge.onMessage(message({ text: `<@${BOT}> take your time` }));
			const thread = threads.get(threadKey("C1", "100.1"))!;
			await until(() => bridge.view(thread.conversationId)?.runTs !== undefined && faux.state.callCount === 1);
			await new Promise((resolve) => setTimeout(resolve, 50)); // the wait tool is running

			if (how === "message") {
				await bridge.onMessage(message({ user: "UBOB", text: `<@${BOT}> stop`, ts: "100.2", threadTs: "100.1" }));
			} else {
				await bridge.onReaction({ channel: "C1", ts: bridge.view(thread.conversationId)!.runTs!, name: "octagonal_sign", user: "UBOB" });
			}
			await settle(thread.conversationId);
			assert.match(surface.texts().at(-1) ?? "", /Stopped by bob\./);
			assert.equal(faux.state.callCount, 1, "the stop itself is not a request to Scout");
		});
	}

	it("ignores a stop when nothing is running, and other reactions", async () => {
		faux.setResponses([fauxAssistantMessage("done")]);
		await bridge.onMessage(message({}));
		const thread = threads.get(threadKey("C1", "100.1"))!;
		await settle(thread.conversationId);
		const sent = surface.sent.length;
		await bridge.onReaction({ channel: "C1", ts: "100.1", name: "octagonal_sign", user: "UBOB" });
		await bridge.onReaction({ channel: "C1", ts: "100.1", name: "thumbsup", user: "UBOB" });
		await bridge.onMessage(message({ text: `<@${BOT}> stop`, ts: "100.2", threadTs: "100.1" }));
		assert.equal(surface.sent.length, sent);
	});

	it("handles a redelivered Slack event once", async () => {
		faux.setResponses([fauxAssistantMessage("once")]);
		await bridge.onMessage(message({}));
		await bridge.onMessage(message({}));
		await settle(threads.get(threadKey("C1", "100.1"))!.conversationId);
		assert.equal(faux.state.callCount, 1);
	});

	it("ignores threads it was never mentioned in", async () => {
		await bridge.onMessage(message({ text: "hello", ts: "200.1" }));
		await bridge.onMessage(message({ text: "hi", ts: "200.2", threadTs: "200.1" }));
		assert.equal(threads.get(threadKey("C1", "200.1")), undefined);
		assert.equal(surface.sent.length, 0);
	});

	it("declines direct messages and private channels", async () => {
		await bridge.onMessage(message({ channel: "D1", channelType: "im", text: "help me" }));
		await bridge.onMessage(message({ channel: "G1", channelType: "group" }));
		await bridge.onMessage(message({ channel: "G1", channelType: "group", text: "no mention", ts: "300.1" }));
		assert.deepEqual(
			surface.sent.map((s) => [s.channel, s.message.text]),
			[
				["D1", DECLINE_PRIVATE],
				["G1", DECLINE_PRIVATE],
			],
		);
		assert.equal(threads.activeSince(0).length, 0);
	});
});
