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
import { ThreadDoc } from "../src/docs.ts";
import { Bridge, DECLINE_PRIVATE, type IncomingMessage } from "../src/bridge.ts";
import { loadProfile, profileExtension } from "../src/profile.ts";
import { Approvals } from "../src/mcp.ts";
import { ThreadSearch } from "../src/search.ts";
import type { ChatMessage, ChatSurface } from "../src/render.ts";
import { threadKey, Threads } from "../src/threads.ts";

const BOT = "UBOT";

type Sent = { op: "post" | "update"; channel: string; ref?: string; message: ChatMessage; ts?: string };

class FakeSurface implements ChatSurface {
	sent: Sent[] = [];
	#ts = 0;
	async post(channel: string, threadTs: string | undefined, message: ChatMessage) {
		const ts = `9000.${++this.#ts}`;
		this.sent.push({ op: "post", channel, ...(threadTs === undefined ? {} : { ref: threadTs }), message, ts });
		return ts;
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
	let approved: string[];
	/** Whether the next run's answer asks for approval, as mcp.ts would say. */
	let asking: boolean;
	let approvals: Approvals;

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
		faux = fauxProvider({ provider: "faux", models: [{ id: "faux-model", input: ["text", "image"] }, { id: "faux-big" }] });
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
			approve: (conversationId, user) => void approved.push(`${conversationId} ${user}`),
			// As mcp.ts would record it: the run that's ending asked for approval.
			answered: (conversationId, ts) => {
				if (asking) approvals.ask(conversationId);
				asking = false;
				approvals.answered(conversationId, ts);
			},
			approvalAskedIn: (ts) => approvals.askedIn(ts),
		});
		approved = [];
		asking = false;
		approvals = new Approvals();
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

	it("continues a thread Scout opened itself, knowing what it said there", async () => {
		await bridge.openThread({ channel: "C1", channelName: "team", threadTs: "500.1", context: "You reviewed pull request 7 and asked for a test.", base: "their-feature" });
		let seen = "";
		faux.setResponses([
			(transcript) => {
				seen = JSON.stringify(transcript);
				return fauxAssistantMessage("Because nothing covers the empty case.");
			},
		]);
		await bridge.onMessage(message({ text: `<@${BOT}> why the test?`, ts: "500.2", threadTs: "500.1" }));
		const thread = threads.get(threadKey("C1", "500.1"));
		assert.ok(thread);
		await settle(thread.conversationId);
		assert.match(seen, /You reviewed pull request 7 and asked for a test\./);
		assert.equal((await harness.snapshot(ThreadDoc, thread.conversationId as never, context))?.base, "their-feature", "it works on the reviewed branch");
		assert.match(seen, /why the test\?/);
		assert.match(surface.texts().at(-1) ?? "", /nothing covers the empty case/);
		assert.equal(search.search("asked for a test")[0]?.key, threadKey("C1", "500.1"), "what it opened the thread with is searchable");
	});

	it("investigates in a thread it opened, with the context it was given", async () => {
		let seen = "";
		faux.setResponses([
			(transcript) => {
				seen = JSON.stringify(transcript);
				return fauxAssistantMessage("Photos is down because its disk is full.");
			},
		]);
		await bridge.investigate({ channel: "C1", channelName: "team", threadTs: "700.1", context: "Investigate calmly.", prompt: "This alert just fired: Photos is down.", requestId: "alert:photos:1" });
		const thread = threads.get(threadKey("C1", "700.1"));
		assert.ok(thread);
		await settle(thread.conversationId);
		assert.match(seen, /Investigate calmly\./);
		assert.match(seen, /Photos is down\./);
		assert.equal(surface.sent[0]?.ref, "700.1", "the answer is in the alert's thread");
		assert.match(surface.texts().at(-1) ?? "", /its disk is full/);
	});

	it("takes \"approve\" from anyone in the thread as approval, and goes on; nothing else counts", async () => {
		faux.setResponses([fauxAssistantMessage("I'd raise the threshold to 90%. Reply approve to go ahead.")]);
		await bridge.onMessage(message({}));
		const thread = threads.get(threadKey("C1", "100.1"))!;
		await settle(thread.conversationId);

		await bridge.onMessage(message({ user: "UBOB", text: "I don't approve", ts: "100.2", threadTs: "100.1" }));
		await settle(thread.conversationId);
		assert.deepEqual(approved, []);

		faux.setResponses([fauxAssistantMessage("Done: raised to 90%.")]);
		await bridge.onMessage(message({ user: "UBOB", text: "Approve.", ts: "100.3", threadTs: "100.1" }));
		await settle(thread.conversationId);
		assert.deepEqual(approved, [`${thread.conversationId} UBOB`]);
		assert.match(surface.texts().at(-1) ?? "", /raised to 90%/, "an approval wakes Scout even without a mention");
	});

	it("adopts a conversation that started without a thread, so replies there reach it", async () => {
		const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: { provider: "faux", modelId: "faux-model" } } }, context);
		await bridge.adopt(conversation.id, { channel: "C1", channelName: "team", threadTs: "500.1", about: "I proposed profile changes." });
		assert.equal(threads.byConversation(conversation.id)?.threadTs, "500.1");
		assert.equal(search.search("proposed profile")[0]?.conversationId, conversation.id, "and it can be found");

		faux.setResponses([fauxAssistantMessage("Revised: the lesson now says the org is lacy.casa.")]);
		await bridge.onMessage(message({ text: `<@${BOT}> the org has a dot in it`, ts: "500.2", threadTs: "500.1" }));
		await settle(conversation.id);
		assert.match(surface.texts().at(-1) ?? "", /Revised/, "a request in the thread reaches the adopted conversation");

		await bridge.adopt(conversation.id, { channel: "C1", channelName: "team", threadTs: "600.1", about: "again" });
		assert.equal(threads.byConversation(conversation.id)?.threadTs, "500.1", "a conversation keeps its first thread");
	});

	it("takes a 👍 on the answer that asked for approval as approval, and nowhere else", async () => {
		faux.setResponses([fauxAssistantMessage("I'd rename the dashboard to Scout test (renamed). React 👍 to go ahead.")]);
		asking = true;
		await bridge.onMessage(message({}));
		const thread = threads.get(threadKey("C1", "100.1"))!;
		await settle(thread.conversationId);
		const asked = surface.sent.find((s) => s.op === "post" && s.ref === "100.1")?.ts;
		assert.ok(asked);

		await bridge.onReaction({ channel: "C1", ts: "100.1", name: "+1", user: "UBOB", eventTs: "300.1" });
		await bridge.onReaction({ channel: "C2", ts: asked, name: "+1", user: "UBOB", eventTs: "300.2" });
		assert.deepEqual(approved, [], "not on the thread's first message, nor the same ts in another channel");

		faux.setResponses([fauxAssistantMessage("Renamed.")]);
		await bridge.onReaction({ channel: "C1", ts: asked, name: "+1", user: "UBOB", eventTs: "300.3" });
		await settle(thread.conversationId);
		assert.deepEqual(approved, [`${thread.conversationId} UBOB`]);
		assert.match(surface.texts().at(-1) ?? "", /Renamed\./, "the reaction wakes Scout like a reply would");

		await bridge.onReaction({ channel: "C1", ts: asked, name: "+1", user: "UANN", eventTs: "300.4" });
		assert.deepEqual(approved, [`${thread.conversationId} UBOB`], "an answer that didn't ask for approval takes none");
	});

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
				await bridge.onReaction({ channel: "C1", ts: bridge.view(thread.conversationId)!.runTs!, name: "octagonal_sign", user: "UBOB", eventTs: "200.1" });
			}
			await settle(thread.conversationId);
			assert.match(surface.texts().at(-1) ?? "", /Stopped by bob\./);
			assert.equal(faux.state.callCount, 1, "the stop itself is not a request to Scout");
		});
	}

	it("says when a reply steered the work, so people know it was heard", async () => {
		faux.setResponses([fauxAssistantMessage([fauxToolCall("wait", {})], { stopReason: "toolUse" })]);
		await bridge.onMessage(message({ text: `<@${BOT}> take your time` }));
		const thread = threads.get(threadKey("C1", "100.1"))!;
		await until(() => bridge.view(thread.conversationId)?.runTs !== undefined && faux.state.callCount === 1);
		await bridge.onMessage(message({ text: "also cover the docs", ts: "100.2", threadTs: "100.1" }));
		await until(() => surface.texts().some((text) => /Took in ann's reply/.test(text)));

		await bridge.onMessage(message({ user: "UBOB", text: `<@${BOT}> stop`, ts: "100.3", threadTs: "100.1" }));
		await settle(thread.conversationId);
		assert.match(surface.texts().at(-1) ?? "", /Stopped by bob\. My last steps:\n• `wait`\n• _Took in ann's reply_/);
	});

	it("ignores a stop when nothing is running, and other reactions", async () => {
		faux.setResponses([fauxAssistantMessage("done")]);
		await bridge.onMessage(message({}));
		const thread = threads.get(threadKey("C1", "100.1"))!;
		await settle(thread.conversationId);
		const sent = surface.sent.length;
		await bridge.onReaction({ channel: "C1", ts: "100.1", name: "octagonal_sign", user: "UBOB", eventTs: "200.1" });
		await bridge.onReaction({ channel: "C1", ts: "100.1", name: "thumbsup", user: "UBOB", eventTs: "200.2" });
		await bridge.onMessage(message({ text: `<@${BOT}> stop`, ts: "100.2", threadTs: "100.1" }));
		assert.equal(surface.sent.length, sent);
	});

	it("shows Scout shared images and saves other files where its tools can read them", async () => {
		const saved: string[] = [];
		const files = new Bridge({
			harness,
			threads,
			surface,
			botUserId: BOT,
			nameOf: async () => "ann",
			agent: { model: { provider: "faux", modelId: "faux-model" } },
			context,
			download: async (url) => new TextEncoder().encode(`bytes of ${url}`),
			saveAttachment: async (id, name) => {
				saved.push(name);
				return `/data/threads/t-${id}/attachments/${name}`;
			},
		});
		let seen = "";
		faux.setResponses([
			(transcript) => {
				seen = JSON.stringify(transcript);
				return fauxAssistantMessage("I see it.");
			},
		]);
		await files.onMessage(
			message({
				text: `<@${BOT}> why does this fail?`,
				files: [
					{ name: "error.png", mimetype: "image/png", size: 100, url: "https://files/error.png" },
					{ name: "build.log", mimetype: "text/plain", size: 100, url: "https://files/build.log" },
					{ name: "dump.bin", mimetype: "application/octet-stream", size: 50 * 1024 * 1024, url: "https://files/dump.bin" },
				],
			}),
		);
		await harness.waitForIdle(context);
		assert.deepEqual(saved, ["build.log"]);
		assert.match(seen, /"type":"image","data":"Ynl0ZXMgb2YgaHR0cHM6Ly9maWxlcy9lcnJvci5wbmc=","mimeType":"image\/png"/);
		assert.match(seen, /\(attached build\.log, saved at \/data\/threads\/t-\d+\/attachments\/build\.log\)/);
		assert.match(seen, /\(attached dump\.bin, 50 MB: too big to open\)/);
	});

	it("uses a channel's own model when its profile names one", async () => {
		let model = "";
		const picky = new Bridge({
			harness,
			threads,
			surface,
			botUserId: BOT,
			nameOf: async () => "ann",
			agent: { model: { provider: "faux", modelId: "faux-model" } },
			context,
			modelFor: (channel) => (channel === "team" ? { provider: "faux", modelId: "faux-big" } : undefined),
		});
		faux.setResponses([
			(_transcript, _options, _state, used) => {
				model = used.id;
				return fauxAssistantMessage("ok");
			},
		]);
		await picky.onMessage(message({}));
		await harness.waitForIdle(context);
		assert.equal(model, "faux-big");
	});

	it("lets admission refuse people, and queue work past a limit", async () => {
		let full = false;
		const gated = new Bridge({
			harness,
			threads,
			surface,
			botUserId: BOT,
			nameOf: async (user) => (user === "UANN" ? "ann" : "bob"),
			agent: { model: { provider: "faux", modelId: "faux-model" } },
			context,
			admit: async ({ user, starting }) => {
				if (user === "UBOB") return { ok: false, reason: "You can't change this repository." };
				if (starting && full) return { ok: false, wait: true, reason: "I'll start on this as soon as I can." };
				return { ok: true };
			},
		});

		const settleGated = async (id: number) => {
			await harness.waitForIdle(context);
			await until(() => gated.view(id)?.busy === false);
			await gated.view(id)?.settled();
		};

		// Bob can't start a thread.
		await gated.onMessage(message({ user: "UBOB", ts: "500.1" }));
		assert.equal(threads.get(threadKey("C1", "500.1")), undefined);
		assert.match(surface.sent.at(-1)?.message.text ?? "", /<@UBOB> You can't change this repository\./);

		// Ann can; Bob's words in her thread are context, not work.
		faux.setResponses([fauxAssistantMessage("on it"), (t) => fauxAssistantMessage(JSON.stringify(t).includes("bob: @Scout delete prod") ? "saw bob" : "missed")]);
		await gated.onMessage(message({ ts: "600.1" }));
		const thread = threads.get(threadKey("C1", "600.1"))!;
		await settleGated(thread.conversationId);
		await gated.onMessage(message({ user: "UBOB", text: `<@${BOT}> delete prod`, ts: "600.2", threadTs: "600.1" }));
		await harness.waitForIdle(context);
		assert.equal(faux.state.callCount, 1, "bob's mention started nothing");

		// Full: Ann's next request waits, then starts when a run ends.
		full = true;
		await gated.onMessage(message({ text: `<@${BOT}> and then?`, ts: "600.3", threadTs: "600.1" }));
		assert.equal(threads.queued().length, 1);
		await gated.view(thread.conversationId)?.settled();
		const placeholder = surface.sent.at(-1)!;
		assert.equal(placeholder.op, "post");
		assert.match(placeholder.message.text, /^⏳ I'll start on this as soon as I can\./, "a message that says it's waiting its turn");

		// She edits it while it waits: the edited request is what runs, in the message that said it was waiting.
		await gated.onEdit({ channel: "C1", ts: "600.3", threadTs: "600.1", user: "UANN", text: `<@${BOT}> and then, in one line?` });
		assert.match(JSON.stringify(threads.queued()[0]!.message), /in one line/);
		full = false;
		await gated.drain();
		await settleGated(thread.conversationId);
		assert.equal(threads.queued().length, 0);
		assert.equal(surface.sent.at(-1)?.ref, placeholder.ts, "the waiting message became the answer");
		assert.match(surface.sent.at(-1)?.message.text ?? "", /saw bob/);

		// A deleted request that's waiting is dropped.
		full = true;
		await gated.onMessage(message({ text: `<@${BOT}> one more`, ts: "600.4", threadTs: "600.1" }));
		assert.equal(threads.queued().length, 1);
		gated.onDelete({ channel: "C1", ts: "600.4" });
		assert.equal(threads.queued().length, 0);
	});

	it("tries again on a 🔁 to its latest answer, and only that one", async () => {
		faux.setResponses([fauxAssistantMessage("I ran into a problem."), (t) => fauxAssistantMessage(JSON.stringify(t).includes("try that again") ? "Second time lucky." : "?")]);
		await bridge.onMessage(message({}));
		const thread = threads.get(threadKey("C1", "100.1"))!;
		await settle(thread.conversationId);
		const answer = threads.get(thread.key)!;
		assert.ok(answer !== undefined);
		const answerTs = surface.sent.filter((s) => s.op === "post" && s.ref === "100.1").at(-1)!.ts!;
		await bridge.onReaction({ channel: "C1", ts: "100.1", name: "repeat", user: "UANN", eventTs: "700.1" });
		assert.equal(faux.state.callCount, 1, "not on the request itself");
		await bridge.onReaction({ channel: "C1", ts: answerTs, name: "repeat", user: "UANN", eventTs: "700.2" });
		await settle(thread.conversationId);
		assert.match(surface.texts().at(-1) ?? "", /Second time lucky\./);
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
