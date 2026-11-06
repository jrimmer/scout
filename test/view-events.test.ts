import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ConversationView } from "@earendil-works/pi-durable";
import { ViewEvents } from "../src/render.ts";

/** A view with the entries and `pi.live` a test names; the rest of a view is not read. */
function view(entries: object[], live: object = {}): ConversationView {
	return { conversation: {}, entries, docs: { "pi.live": live } } as never;
}
const types = (events: { type: string }[]) => events.map((e) => e.type);
const answer = (id: number, text: string) => ({ id, kind: "assistant", model: [{ role: "assistant", content: [{ type: "text", text }] }] });
const askForTool = (id: number, callId: string, args: object) => ({ id, kind: "assistant", model: [{ role: "assistant", content: [{ type: "toolCall", id: callId, name: "bash", arguments: args }] }] });

describe("turning a conversation's view into run events", () => {
	it("starts with a snapshot, whatever the view holds, and replays no earlier entries", () => {
		const events = new ViewEvents();
		const first = events.next(view([answer(1, "Earlier.")], { run: { taskId: 1 } }));
		assert.deepEqual(types(first), ["snapshot"]);
		assert.ok((first[0] as { run?: object }).run !== undefined, "attached mid-run");
		assert.deepEqual(events.next(view([answer(1, "Earlier.")], { run: { taskId: 1 } })), [], "nothing changed");
	});

	it("follows a run from its start to its answer and its end", () => {
		const events = new ViewEvents();
		events.next(view([]));
		assert.deepEqual(types(events.next(view([], { run: { taskId: 1 } }))), ["run_start"]);
		assert.deepEqual(types(events.next(view([], { run: { taskId: 1 }, generation: { attempt: 1, message: { role: "assistant", content: [] } } }))), ["message_start"]);
		const done = events.next(view([answer(5, "Done.")], {}));
		assert.deepEqual(types(done), ["message_end", "run_end"]);
		assert.deepEqual(types(events.next(view([answer(5, "Done.")], {}))), [], "an entry is reported once");
	});

	it("reads a step's arguments from the answer that asked for it, and what went wrong from the result", () => {
		const events = new ViewEvents();
		events.next(view([]));
		const run = { run: { taskId: 1 } };
		const asked = askForTool(2, "c1", { command: "mix test" });
		const started = events.next(view([asked], { ...run, tools: [{ callId: "c1", name: "bash", status: "running" }] }));
		const start = started.find((e) => e.type === "tool_execution_start") as { args: object; toolName: string };
		assert.deepEqual(start.args, { command: "mix test" });
		assert.equal(start.toolName, "bash");
		const result = { id: 3, kind: "tool", data: { diagnostics: [{ code: "invalid_arguments" }] } };
		const ended = events.next(view([asked, result], { ...run, tools: [{ callId: "c1", name: "bash", status: "done", entry: 3 }] }));
		const end = ended.find((e) => e.type === "tool_execution_end") as { entry?: { data?: { diagnostics?: { code: string }[] } } };
		assert.equal(end.entry?.data?.diagnostics?.[0]?.code, "invalid_arguments");
		assert.deepEqual(types(events.next(view([asked, result], { ...run, tools: [{ callId: "c1", name: "bash", status: "done", entry: 3 }] }))), [], "a finished call is reported once");
	});

	it("ends a call whose slot went before it finished, and says a retry began and ended", () => {
		const events = new ViewEvents();
		events.next(view([]));
		events.next(view([], { run: { taskId: 1 }, tools: [{ callId: "c9", name: "bash", status: "running" }] }));
		assert.deepEqual(types(events.next(view([], { run: { taskId: 1 }, generation: { attempt: 2, retry: { at: 10, error: "x" } } }))), ["auto_retry_start", "tool_execution_end"]);
		assert.deepEqual(types(events.next(view([], { run: { taskId: 1 } }))), ["auto_retry_end"]);
	});

	it("says why a run ended without an answer, except when someone stopped it", () => {
		const events = new ViewEvents();
		events.next(view([]));
		events.next(view([], { run: { taskId: 1 } }));
		const failed = events.next(view([], { runFailure: { taskId: 1, inputs: [], reason: "restart_limit" } }));
		assert.deepEqual(types(failed), ["task_failed", "run_end"]);
		assert.match((failed[0] as { message: string }).message, /interrupted too many times/);

		const stopped = new ViewEvents();
		stopped.next(view([]));
		stopped.next(view([], { run: { taskId: 1 } }));
		assert.deepEqual(types(stopped.next(view([], { runFailure: { taskId: 1, inputs: [], reason: "aborted" } }))), ["run_end"]);
	});

	it("notes a compaction when it begins", () => {
		const events = new ViewEvents();
		events.next(view([]));
		assert.deepEqual(types(events.next(view([], { run: { taskId: 1 }, compactions: [{ taskId: 2, trigger: "auto", blocking: false, attempt: 1 }] }))), ["run_start", "compaction_start"]);
	});
});
