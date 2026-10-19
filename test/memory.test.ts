import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { ThreadDoc } from "../src/docs.ts";
import { Memory, memoryExtension } from "../src/memory.ts";

describe("memory", () => {
	it("keeps notes per channel, everywhere, and forgets", () => {
		const memory = new Memory(":memory:");
		const a = memory.remember("deploys", "Use ./bin/deploy, not make deploy.");
		memory.remember("", "The CI cache key changes on Mondays.");
		memory.remember("checkout", "Checkout tests need Redis.");
		assert.deepEqual(memory.forChannel("deploys").map((n) => n.note), [
			"Use ./bin/deploy, not make deploy.",
			"The CI cache key changes on Mondays.",
		]);
		assert.equal(memory.forget(a), true);
		assert.equal(memory.forget(a), false);
		assert.deepEqual(memory.forChannel("deploys").map((n) => n.id), [2]);
		memory.close();
	});

	it("retires consolidated notes only when the proposal merges", () => {
		const memory = new Memory(":memory:");
		const a = memory.remember("deploys", "one");
		const b = memory.remember("deploys", "two");
		assert.equal(memory.consolidate([a, b, 99], "2026-10-19"), 2);
		memory.proposalDecided("2026-10-19", false);
		assert.equal(memory.active().length, 2, "a rejected proposal keeps the notes");
		memory.consolidate([a], "2026-10-20");
		memory.proposalDecided("2026-10-20", true);
		assert.deepEqual(memory.active().map((n) => n.note), ["two"]);
		memory.close();
	});

	it("lets a thread note something that the next thread in the channel sees", async () => {
		const memory = new Memory(":memory:");
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = createRegistry();
		registry.install(memoryExtension(memory));
		const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
		const thread = async () =>
			harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: { model: { provider: "faux", modelId: "m" } },
					init: async (tx, id) => {
						(await tx.doc(ThreadDoc, id)).channelName = "deploys";
					},
				},
				context,
			);

		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("remember", { note: "Deploys need the release role." })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Noted."),
		]);
		await (await (await thread()).submit({ type: "input", content: "remember that" }, context)).wait(context);

		let seen = "";
		faux.setResponses([
			(transcript) => {
				seen = JSON.stringify(transcript);
				return fauxAssistantMessage("ok");
			},
		]);
		await (await (await thread()).submit({ type: "input", content: "deploy?" }, context)).wait(context);
		assert.match(seen, /\[1\] Deploys need the release role\./);
		await harness.close(context);
		memory.close();
	});
});
