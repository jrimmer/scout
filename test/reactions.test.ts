import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadProfile } from "../src/profile.ts";
import { DEFAULT_EMOJI, StatusReactions, toolPhase } from "../src/reactions.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function harness() {
	let now = 0;
	const calls: string[] = [];
	const status = new StatusReactions({
		react: async (_c, ts, name, on) => void calls.push(`${on ? "+" : "-"}${name}@${ts}`),
		now: () => now,
		later: () => {},
	});
	return {
		status,
		calls,
		at: async (ms: number) => {
			now = ms;
			await status.tick();
		},
	};
}

describe("the request's reaction follows the work", () => {
	it("shows a phase once it has lasted, keeps it long enough to read, and skips the flickers in between", async () => {
		const { status, calls, at } = harness();
		status.set("C", "1", "picked");
		await at(1_500);
		assert.deepEqual(calls, ["+eyes@1"]);
		status.set("C", "1", "thinking");
		await at(2_000);
		assert.deepEqual(calls, ["+eyes@1"], "not yet: 👀 has been up under 3 s, and thinking under 1.5 s");
		status.set("C", "1", "reading");
		status.set("C", "1", "thinking"); // a sub-second tool call: never shown
		await at(4_600);
		assert.deepEqual(calls, ["+eyes@1", "+brain@1", "-eyes@1"], "one reaction at a time: the old one goes");
		status.set("C", "1", "testing");
		await at(7_700);
		assert.deepEqual(calls.slice(-2), ["+test_tube@1", "-brain@1"]);
	});

	it("shows how a run ended at once, and lets nothing after it overwrite that", async () => {
		const { status, calls, at } = harness();
		status.set("C", "1", "picked");
		await at(1_500);
		status.set("C", "1", "testing");
		status.finish("C", "1", "done");
		await at(3_100);
		assert.deepEqual(calls, ["+eyes@1", "+white_check_mark@1", "-eyes@1"], "no waiting out the dwell for the ending");
		status.set("C", "1", "thinking");
		await at(9_000);
		assert.equal(calls.length, 3, "a straggling phase can't replace the ending");
		assert.equal(status.pending, 0);
	});

	it("paces changes across the whole workspace, sending only the latest phase of each message", async () => {
		const { status, calls, at } = harness();
		for (const ts of ["1", "2", "3"]) status.set("C", ts, "picked");
		await at(1_500);
		await at(1_600);
		await at(3_000);
		await at(4_500);
		assert.deepEqual(calls, ["+eyes@1", "+eyes@2", "+eyes@3"], "one change every 1.5 s, however many requests");
		status.set("C", "1", "reading");
		status.set("C", "1", "editing");
		status.set("C", "1", "testing");
		await at(9_000);
		assert.deepEqual(calls.slice(-2), ["+test_tube@1", "-eyes@1"], "only the latest wanted phase was sent");
	});

	it("knows a tool call's phase from its name, and a command's from what it runs", () => {
		assert.equal(toolPhase("read", {}), "reading");
		assert.equal(toolPhase("search_code", {}), "reading");
		assert.equal(toolPhase("edit", {}), "editing");
		assert.equal(toolPhase("bash", { command: "cd repo && python3 -m unittest" }), "testing");
		assert.equal(toolPhase("bash", { command: "npm ci" }), "building");
		assert.equal(toolPhase("bash", { command: "git log -5" }), "command");
		assert.equal(toolPhase("mcp__grafana__query_prometheus", {}), "systems");
		assert.equal(toolPhase("open_pull_request", {}), "pull");
		assert.equal(toolPhase("remember", {}), "tool");
	});

	it("takes the emoji for each phase from the profile, and says what it can't use", () => {
		const dir = mkdtempSync(join(tmpdir(), "scout-reactions-"));
		writeFileSync(join(dir, "system.md"), "You are Scout.");
		writeFileSync(join(dir, "reactions.md"), "---\ntesting: :microscope:\nthinking: thought_balloon\nsleeping: zzz\nreading: 📖\n---\n");
		const profile = loadProfile(dir);
		assert.deepEqual(profile.reactions, { testing: "microscope", thinking: "thought_balloon" });
		assert.equal(profile.problems.length, 2);
		assert.match(profile.problems.join("\n"), /no phase "sleeping"/);
		assert.match(profile.problems.join("\n"), /isn't a Slack emoji name/);
		assert.equal(DEFAULT_EMOJI.testing, "test_tube");
	});
});
