import assert from "node:assert/strict";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { Approaches, approachesExtension, chooseApproach, comparison } from "../src/approaches.ts";
import { ThreadDoc } from "../src/docs.ts";
import { LocalDriver } from "../src/drivers/local.ts";
import type { ChatMessage } from "../src/render.ts";
import { Workspaces } from "../src/workspaces.ts";
import { bareRepo, tempDir } from "./helpers.ts";

const toolUse = { stopReason: "toolUse" } as const;

describe("trying several approaches (experimental)", () => {
	const root = tempDir("scout-approaches-");
	const remote = bareRepo(root, "app");
	const workspaces = new Workspaces({
		dataDir: join(root, "data"),
		instance: "t",
		repos: [{ name: "app", gitUrl: remote, base: "main" }],
		driver: new LocalDriver({ root: join(root, "sandboxes") }),
		sandbox: { image: "unused", network: "none" },
		git: { name: "Scout", email: "scout@localhost" },
	});
	after(() => workspaces.close());

	/** A thread whose model asks to try a cache or a query fix, and plays each approach; `room` caps how many run at once. */
	async function tryBoth(room?: () => Promise<number>) {
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const store = new Approaches(":memory:");
		const shown: ChatMessage[] = [];
		const coding = createCodingTools();
		const pullRequests = defineExtension({ name: "codehost", tools: [] });
		const approaches = approachesExtension({
			store,
			workspaces,
			costOf: () => 0.01,
			show: async (_parent, message, ts) => {
				shown.push(message);
				return ts ?? "100.2";
			},
			childWithout: () => [approaches, pullRequests],
			room,
		});
		const registry = createRegistry();
		for (const extension of [coding, approaches, pullRequests]) registry.install(extension);
		const harness = await Harness.open(new MemoryStorage(), { models, registry, env: async (target) => workspaces.env(target.conversationId) }, context);
		const thread = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: { provider: "faux", modelId: "m" }, extensions: [coding, approaches, pullRequests] },
				init: async (tx, id) => {
					Object.assign(await tx.doc(ThreadDoc, id), { channel: "C1", channelName: "team", threadTs: "100.1", repo: "app" });
				},
			},
			context,
		);

		// One model plays all three: the thread, and each approach (told apart by what it was asked).
		const plays = (transcript: { messages: unknown[] }) => {
			const text = JSON.stringify(transcript.messages);
			const last = JSON.stringify(transcript.messages.at(-1));
			const mine = /Yours: \*(Cache|Query)\*/.exec(text)?.[1];
			if (mine === undefined) {
				if (/"role":"toolResult"/.test(last)) return fauxAssistantMessage("Both are up; pick one.");
				return fauxAssistantMessage([fauxToolCall("try_approaches", { request: "make it faster", approaches: [{ name: "Cache", plan: "cache results" }, { name: "Query", plan: "fix the query" }] })], toolUse);
			}
			if (/"role":"toolResult"/.test(last)) return fauxAssistantMessage(`Added ${mine.toLowerCase()}.txt.\nTrade-off: ${mine === "Cache" ? "stale data" : "a migration"}.\nTests: passed`);
			const file = `${mine.toLowerCase()}.txt`;
			return fauxAssistantMessage([fauxToolCall("bash", { command: `echo ${mine} > ${file} && git add ${file} && git commit -qm '${mine}'` })], toolUse);
		};
		faux.setResponses(Array.from({ length: 12 }, () => plays));

		await (await thread.submit({ type: "input", content: "try a cache or fixing the query" }, context)).wait(context);
		return { harness, thread, store, shown };
	}

	it("runs each approach in its own sandbox from the thread's branch, compares them, and brings the chosen one back", async () => {
		const { harness, thread, store, shown } = await tryBoth();
		const results = store.forThread(thread.id);
		assert.deepEqual(results.map((a) => [a.name, a.state, a.tests, a.diff]), [
			["Cache", "done", "passed", "+1 −0 in 1 file"],
			["Query", "done", "passed", "+1 −0 in 1 file"],
		]);
		const last = JSON.stringify(shown.at(-1)!.blocks);
		assert.match(last, /🧪 _Experimental:_ trying 2 approaches side by side/);
		assert.match(last, /✅ \*1\. Cache\*: tests passed · \+1 −0 in 1 file · \$0\.01/);
		assert.match(last, /Trade-off: stale data/);
		assert.match(last, /"action_id":"scout_use_approach_2","text":\{"type":"plain_text","text":"Use 2\. Query"\},"value":"\d+:2"/);

		const chosen = await chooseApproach({ store, workspaces }, thread.id, 2, "UANN");
		assert.equal(chosen.name, "Query");
		const env = await workspaces.env(thread.id);
		let out = "";
		await env.exec("git log -1 --format=%s; ls", { onOutput: (t) => (out += t) }, context);
		assert.match(out, /^Query\n/, "the chosen approach's commit is on the thread's branch");
		assert.doesNotMatch(out, /cache\.txt/, "and only that one");
		await assert.rejects(chooseApproach({ store, workspaces }, thread.id, 1, "UBOB"), /already been chosen/);
		assert.match(JSON.stringify(comparison(store.forThread(thread.id), Date.now(), () => 0, true).blocks), /<@UANN> chose \*2\. Query\*/);
		await harness.close(context);
		store.close();
	});

	it("runs only as many approaches as the run limits leave room for, and starts the rest as those finish", async () => {
		const { harness, thread, store, shown } = await tryBoth(async () => 1);
		const messages = shown.map((m) => JSON.stringify(m.blocks));
		const waiting = messages.find((m) => /waiting for room/.test(m));
		assert.ok(waiting !== undefined, "the second approach is shown waiting");
		assert.match(waiting, /I'm busy elsewhere too, so 1 run now; the other starts as soon as one finishes\./);
		assert.deepEqual(store.forThread(thread.id).map((a) => a.state), ["done", "done"], "and it ran once the first finished");
		assert.doesNotMatch(messages.at(-1)!, /busy elsewhere/);
		await harness.close(context);
		store.close();
	});

	it("refuses to start from uncommitted work", async () => {
		const store = new Approaches(":memory:");
		const extension = approachesExtension({ store, workspaces: { status: async () => " M a.txt" } as never, costOf: () => 0, show: async () => undefined, childWithout: () => [] });
		await assert.rejects(extension.tools![0]!.execute({ request: "x", approaches: [{ name: "a", plan: "a" }, { name: "b", plan: "b" }] }, { conversationId: 1 } as never, context), /Commit your work first/);
		store.close();
	});
});
