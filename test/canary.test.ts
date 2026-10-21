import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CANARY_FILE, describeCanary, runCanary, type SlackCall } from "../src/canary.ts";
import type { Forge } from "../src/forge.ts";

/** A thread whose replies appear as time passes: at each of `at` (ms after the request), that message. */
function slackWith(replies: { at: number; user: string; text: string }[], clock: { t: number }, options: { post?: boolean } = {}) {
	const calls: { method: string; args: Record<string, string> }[] = [];
	const slack: SlackCall = async (method, args) => {
		calls.push({ method, args });
		if (method === "chat.postMessage") return options.post === false ? { ok: false, error: "not_in_channel" } : { ok: true, ts: "100.0" };
		if (method === "conversations.replies") {
			const seen = replies.filter((r) => r.at <= clock.t).map((r, i) => ({ ts: `10${i + 1}.0`, user: r.user, text: r.text }));
			return { ok: true, messages: [{ ts: "100.0", user: "UCANARY", text: args.ts }, ...seen] };
		}
		return { ok: false, error: "unknown_method" };
	};
	return { slack, calls };
}

function forgeWith(files: string[]) {
	const done: string[] = [];
	const forge = {
		pullFiles: async (_slug: string, number: number) => (done.push(`files #${number}`), files),
		headBranch: async (_slug: string, number: number) => (done.push(`branch #${number}`), "scout/1-2"),
		closePull: async (_slug: string, number: number) => void done.push(`close #${number}`),
		deleteBranch: async (_slug: string, branch: string) => void done.push(`delete ${branch}`),
	} as unknown as Forge;
	return { forge, done };
}

function run(slack: SlackCall, forge: Forge, clock: { t: number }) {
	return runCanary({
		slack,
		forge,
		channel: "C0CANARY",
		scout: "USCOUT",
		slug: "acme/playground",
		replyWithinMs: 5 * 60_000,
		pullWithinMs: 30 * 60_000,
		pollMs: 30_000,
		now: () => clock.t,
		sleep: async (ms) => void (clock.t += ms),
	});
}

describe("canary", () => {
	it("asks Scout like a person, finds the pull request, checks it, and cleans up", async () => {
		const clock = { t: 0 };
		const { slack, calls } = slackWith(
			[
				{ at: 40_000, user: "USCOUT", text: "On it." },
				{ at: 400_000, user: "UOTHER", text: "https://git.example/acme/playground/pulls/99" },
				{ at: 600_000, user: "USCOUT", text: "Opened <https://git.example/acme/playground/pulls/12|#12>." },
			],
			clock,
		);
		const { forge, done } = forgeWith([CANARY_FILE]);
		const result = await run(slack, forge, clock);

		assert.equal(result.ok, true, result.problem ?? "");
		assert.equal(result.pull, "acme/playground#12", "only Scout's own reply counts");
		assert.equal(result.repliedMs, 60_000);
		assert.equal(result.pullMs, 600_000);
		const asked = calls[0]!;
		assert.equal(asked.method, "chat.postMessage");
		assert.match(asked.args.text!, /^<@USCOUT> .*CANARY\.md.*open a pull request/);
		assert.deepEqual(done, ["files #12", "branch #12", "close #12", "delete scout/1-2"]);
		assert.match(describeCanary(result), /^Scout is working: acme\/playground#12 \(answered in 60s, pull request in 10m00\)$/);
	});

	it("fails when Scout doesn't answer at all, and says so", async () => {
		const clock = { t: 0 };
		const { slack } = slackWith([], clock);
		const { forge, done } = forgeWith([CANARY_FILE]);
		const result = await run(slack, forge, clock);
		assert.equal(result.ok, false);
		assert.equal(result.problem, "Scout didn't answer within 5 minutes");
		assert.ok(clock.t <= 6 * 60_000, "it gives up once the time to answer has passed");
		assert.deepEqual(done, []);
	});

	it("fails when Scout answers but no pull request comes of it in time", async () => {
		const clock = { t: 0 };
		const { slack } = slackWith([{ at: 10_000, user: "USCOUT", text: "Working on it." }], clock);
		const result = await run(slack, forgeWith([]).forge, clock);
		assert.equal(result.ok, false);
		assert.equal(result.problem, "no pull request within 30 minutes");
		assert.equal(result.repliedMs, 30_000);
	});

	it("fails when the pull request doesn't make the change, and still cleans up", async () => {
		const clock = { t: 0 };
		const { slack } = slackWith([{ at: 10_000, user: "USCOUT", text: "https://git.example/acme/playground/pulls/3" }], clock);
		const { forge, done } = forgeWith(["README.md"]);
		const result = await run(slack, forge, clock);
		assert.equal(result.ok, false);
		assert.equal(result.problem, "the pull request doesn't change CANARY.md (it changes README.md)");
		assert.ok(done.includes("close #3"));
	});

	it("fails straight away when it can't post", async () => {
		const clock = { t: 0 };
		const { slack } = slackWith([], clock, { post: false });
		const result = await run(slack, forgeWith([]).forge, clock);
		assert.deepEqual(result, { ok: false, problem: "couldn't post the request in Slack (not_in_channel)" });
	});
});
