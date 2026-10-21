import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { ThreadDoc } from "../src/docs.ts";
import { nextTime, parseCron, Schedules, schedulesExtension } from "../src/schedules.ts";

/** Local time, like the schedules themselves. */
const local = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).getTime();
const MINUTE = 60_000;

describe("schedules", () => {
	it("reads cron, and says plainly what's wrong with a bad one", () => {
		const cron = parseCron("*/15 9-17 * * 1-5");
		assert.deepEqual([...cron.minute], [0, 15, 30, 45]);
		assert.deepEqual([...cron.hour], [9, 10, 11, 12, 13, 14, 15, 16, 17]);
		assert.deepEqual([...parseCron("0 9 * * 7").weekday], [0], "Sunday is 7 as well as 0");
		assert.throws(() => parseCron("0 9 * *"), /five fields/);
		assert.throws(() => parseCron("60 9 * * *"), /out of range for minute/);
		assert.throws(() => parseCron("0 9 * * mon"), /isn't a valid day of week/);
	});

	it("finds the next time, including a day-of-month and weekday either-or", () => {
		const monday9 = "0 9 * * 1";
		// Tuesday 2026-10-20 18:00 local: the next Monday 9:00 is the 26th.
		assert.equal(nextTime(monday9, local(2026, 10, 20, 18, 0)), local(2026, 10, 26, 9, 0));
		assert.equal(nextTime("30 8 1 1 *", local(2026, 10, 20, 18, 0)), local(2027, 1, 1, 8, 30), "a yearly one, quickly");
		// The 1st, or any Friday: Friday the 23rd comes first.
		assert.equal(nextTime("0 7 1 * 5", local(2026, 10, 20, 18, 0)), local(2026, 10, 23, 7, 0));
	});

	it("runs a schedule once at its time, catches up after a short outage, and skips paused or removed ones", () => {
		const schedules = new Schedules(":memory:");
		const s = schedules.add({ channel: "deps", cron: "0 9 * * 1", when: "every Monday at 9:00", task: "check for dependency updates", by: "UANN" });
		const nine = local(2026, 10, 26, 9, 0);
		assert.deepEqual(schedules.due(nine - MINUTE), []);
		assert.deepEqual(schedules.due(nine + 20_000).map((d) => d.id), [s.id]);
		schedules.ran(s.id, nine + 20_000);
		assert.deepEqual(schedules.due(nine + 50_000), [], "not twice for the same time");

		// Scout was down at 9:00 next week and came back at 9:07: it still runs; at 9:30 it's too late.
		// (A week later in local time: daylight saving ends in between, so it isn't 7 × 24 hours.)
		const next = local(2026, 11, 2, 9, 0);
		assert.deepEqual(schedules.due(next + 7 * MINUTE).map((d) => d.id), [s.id]);
		assert.deepEqual(schedules.due(next + 30 * MINUTE), []);

		schedules.change(s.id, { paused: true }, "UBOB");
		assert.deepEqual(schedules.due(next), []);
		assert.equal(schedules.get(s.id)?.changedBy, "UBOB");
		schedules.remove(s.id, "UBOB");
		assert.equal(schedules.get(s.id), undefined);
		assert.deepEqual(schedules.forChannel("deps"), []);
		assert.throws(() => schedules.add({ channel: "deps", cron: "every monday", when: "", task: "", by: "UANN" }), /five fields/);
		schedules.close();
	});

	it("lets a thread set up, list and change its channel's schedules, recording who asked", async () => {
		const schedules = new Schedules(":memory:");
		const other = schedules.add({ channel: "elsewhere", cron: "0 0 * * *", when: "daily at midnight", task: "other channel's", by: "UZED" });
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		const registry = createRegistry();
		const audited: string[] = [];
		const audit = { record: (kind: string, e: { actor: string }) => void audited.push(`${kind} ${e.actor}`) };
		registry.install(schedulesExtension(schedules, () => "UANN", audit as never));
		const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
		const conversation = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: { model: { provider: "faux", modelId: "m" } },
				init: async (tx, id) => {
					(await tx.doc(ThreadDoc, id)).channelName = "deps";
				},
			},
			context,
		);
		const results: string[] = [];
		const toolUse = { stopReason: "toolUse" } as const;
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("schedule", { cron: "0 9 * * 1", when: "every Monday at 9:00", task: "Check for dependency updates." })], toolUse),
			fauxAssistantMessage([fauxToolCall("change_schedule", { id: other.id, paused: true })], toolUse),
			(transcript) => {
				results.push(JSON.stringify(transcript.messages.at(-1)));
				return fauxAssistantMessage([fauxToolCall("schedules", {})], toolUse);
			},
			(transcript) => {
				results.push(JSON.stringify(transcript.messages.at(-1)));
				return fauxAssistantMessage("Set up: every Monday at 9:00.");
			},
		]);
		await (await conversation.submit({ type: "input", content: "every Monday at 9, check for dependency updates" }, context)).wait(context);

		assert.match(results[0]!, /no schedule #1 in this channel/, "another channel's schedule is out of reach");
		assert.match(results[1]!, /#2: every Monday at 9:00 \(`0 9 \* \* 1`\): Check for dependency updates\. Set up by <@UANN>\. Next:/);
		assert.equal(schedules.get(other.id)?.paused, false);
		assert.deepEqual(audited, ["schedule_added UANN"]);
		await harness.close(context);
		schedules.close();
	});
});
