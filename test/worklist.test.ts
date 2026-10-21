import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ListsApi, WorkList } from "../src/worklist.ts";

function fakeLists() {
	const calls: { op: string; args: Record<string, unknown> }[] = [];
	const api: ListsApi = {
		create: async (args) => {
			calls.push({ op: "create", args });
			return {
				list_id: "L1",
				list_metadata: {
					schema: (args.schema as { key: string; options?: { choices?: { value: string; label: string }[] } }[]).map((c, i) => ({
						id: `Col${i}`,
						key: c.key,
						...(c.options?.choices === undefined ? {} : { options: { choices: c.options.choices.map((x, j) => ({ value: `Opt${i}${j}`, label: x.label })) } }),
					})),
				},
			};
		},
		access: { set: async (args) => void calls.push({ op: "access", args }) },
		items: {
			create: async (args) => {
				calls.push({ op: "item", args });
				return { item: { id: "Row1" } };
			},
			update: async (args) => void calls.push({ op: "update", args }),
		},
	};
	return { calls, api };
}

describe("the list of Scout's work", () => {
	it("makes the list once, shares it with the home channel, and keeps one row per thread", async () => {
		const { calls, api } = fakeLists();
		const list = new WorkList({ path: ":memory:", api: () => api, shareWith: async () => "CHOME" });
		await Promise.all([
			list.update(7, { request: "Fix the flaky login test", channel: "C1", askedBy: "UANN", state: "Working", thread: "https://slack/t7" }),
			list.update(8, { request: "Rename the dashboard", channel: "C2", state: "Working" }),
		]);
		assert.equal(calls.filter((c) => c.op === "create").length, 1, "one list, however many rows arrive at once");
		assert.deepEqual(calls.find((c) => c.op === "access")?.args, { list_id: "L1", access_level: "read", channel_ids: ["CHOME"] });
		const first = calls.find((c) => c.op === "item")!.args.initial_fields as Record<string, unknown>[];
		assert.deepEqual(first[0], { column_id: "Col0", rich_text: [{ type: "rich_text", elements: [{ type: "rich_text_section", elements: [{ type: "text", text: "Fix the flaky login test" }] }] }] });
		assert.deepEqual(first.find((f) => f.column_id === "Col3"), { column_id: "Col3", select: ["Opt30"] }, "Working, as Slack's own option ID");

		await list.update(7, { state: "Pull request open", pull: { url: "https://host/o/r/pulls/12", label: "o/r#12" }, ci: "Failing", cost: 0.0349 });
		const update = calls.at(-1)!;
		assert.equal(update.op, "update");
		assert.deepEqual(update.args.cells, [
			{ column_id: "Col3", select: ["Opt34"], row_id: "Row1" },
			{ column_id: "Col4", link: [{ original_url: "https://host/o/r/pulls/12", display_as_url: false, display_name: "o/r#12" }], row_id: "Row1" },
			{ column_id: "Col5", select: ["Opt51"], row_id: "Row1" },
			{ column_id: "Col6", number: [0.03], row_id: "Row1" },
		]);
		assert.equal(list.id, "L1");
		list.close();
	});
});
