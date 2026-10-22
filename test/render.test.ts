import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { delivery } from "../src/etiquette.ts";
import { frontmatter } from "../src/profile.ts";
import { type ChatMessage, describeStep, finalMessage, progressMessage, SAYINGS, ThreadView } from "../src/render.ts";
import { mentionNames, slackChannelName } from "../src/slack.ts";

describe("render", () => {
	it("describes steps briefly", () => {
		assert.equal(describeStep("bash", { command: "npm test\nnpm run lint" }), "`bash npm test`");
		assert.equal(describeStep("read", { path: "src/a.ts" }), "`read src/a.ts`");
		assert.equal(describeStep("open_pull_request", { title: "Fix `x`" }), "`open_pull_request Fix 'x'`");
	});

	it("shows the latest steps while working", () => {
		const steps = Array.from({ length: 9 }, (_, i) => `step ${i}`);
		const text = (progressMessage({ startedAt: 0, steps }, 75_000).blocks[0] as { text: string }).text;
		assert.match(text, /Working… 1m 15s/);
		assert.match(text, /…3 earlier steps/);
		assert.doesNotMatch(text, /step 2\b/);
		assert.match(text, /step 8/);
	});

	it("shows the notes Scout kept, so people can object", () => {
		const message = finalMessage({ startedAt: 0, steps: [], text: "Done.", notes: ["Deploys need the release role."] }, 1000);
		assert.match(JSON.stringify(message.blocks), /Noted for this channel: “Deploys need the release role\.”\. Disagree\? Tell me to forget it\./);
		assert.doesNotMatch(JSON.stringify(finalMessage({ startedAt: 0, steps: [], text: "Done." }, 1000).blocks), /Noted/);
	});

	it("puts what the run cost in the footer, after its steps and time", () => {
		const message = finalMessage({ startedAt: 0, steps: ["`bash npm test`"], text: "Done.", cost: "$0.03 · $12.40 of $100 this week" }, 130_000);
		assert.match(JSON.stringify(message.blocks), /1 step · 2m 10s · \$0\.03 · \$12\.40 of \$100 this week/);
		assert.match(JSON.stringify(finalMessage({ startedAt: 0, steps: [], text: "Done." }, 1000).blocks), /"0 steps · 1s"/);
	});

	it("keeps a stopped run's last steps when it had no words yet", () => {
		const message = finalMessage({ startedAt: 0, steps: ["`bash npm test`", "`open_pull_request Fix it`"], stoppedBy: "ann" }, 1000);
		assert.match(message.text, /Stopped by ann\. My last steps:\n• `bash npm test`\n• `open_pull_request Fix it`/);
	});

	it("says what went wrong when a run fails without an answer", () => {
		const message = finalMessage({ startedAt: 0, steps: [], error: "model overloaded" }, 1000);
		assert.match(message.text, /ran into a problem.*model overloaded/);
	});

	it("says the model didn't answer instead of \"Done.\" when its calls failed", async () => {
		const posted: string[] = [];
		const surface = {
			post: async () => "1.1",
			update: async (_c: string, _ts: string, m: ChatMessage) => void posted.push(m.text),
		};
		const failed = { role: "assistant", content: [], stopReason: "error", errorMessage: '400: {"type":"server_error","message":"scheduler admission timeout"}' };
		const view = new ThreadView({ surface, channel: "C", threadTs: "1" });
		view.handle([{ type: "run_start", inputs: [] }]);
		view.handle([{ type: "message_end", entry: { model: [failed] } } as never]);
		view.handle([{ type: "run_end", inputs: [] }]);
		await view.settled();
		assert.match(posted.at(-1) ?? "", /^I ran into a problem and stopped: the model didn't answer \(scheduler admission timeout\)/);

		const said = { role: "assistant", content: [{ type: "text", text: "Checking the disk." }], stopReason: "toolUse" };
		view.handle([{ type: "run_start", inputs: [] }]);
		view.handle([{ type: "message_end", entry: { model: [said] } } as never]);
		view.handle([{ type: "message_end", entry: { model: [failed] } } as never]);
		view.handle([{ type: "run_end", inputs: [] }]);
		await view.settled();
		assert.match(posted.at(-1) ?? "", /^Checking the disk\.\n\n_Then I ran into a problem and stopped: the model didn't answer/);
	});
});

describe("etiquette", () => {
	it("steers while busy, answers when addressed, otherwise notes", () => {
		assert.equal(delivery({ busy: true, mentionsScout: false, followsScout: false }), "steer");
		assert.equal(delivery({ busy: false, mentionsScout: true, followsScout: false }), "input");
		assert.equal(delivery({ busy: false, mentionsScout: false, followsScout: true }), "input");
		assert.equal(delivery({ busy: false, mentionsScout: false, followsScout: false }), "note");
	});
});

describe("helpers", () => {
	it("reads frontmatter values without trailing comments or quotes", () => {
		const { meta } = frontmatter('---\nmodel: anthropic/claude-sonnet-5-5    # optional\noncall: "@ann"\nchannel: #ops\n---\nbody');
		assert.deepEqual(meta, { model: "anthropic/claude-sonnet-5-5", oncall: "@ann", channel: "#ops" });
	});

	it("parses skill frontmatter", () => {
		assert.deepEqual(frontmatter("---\ndescription: Query the warehouse\n---\nBody"), {
			meta: { description: "Query the warehouse" },
			body: "Body",
		});
		assert.deepEqual(frontmatter("No frontmatter"), { meta: {}, body: "No frontmatter" });
	});

	it("turns @names into mentions, but not in code, emails, scopes or for unknown names", () => {
		const handles = new Map([["jason", "U1"], ["ann.lee", "U2"]]);
		assert.equal(mentionNames("Done, @jason. Over to @Ann.Lee.", handles), "Done, <@U1>. Over to <@U2>.");
		assert.equal(mentionNames("Ask @nobody, mail jason@example.com, see <@U9>", handles), "Ask @nobody, mail jason@example.com, see <@U9>");
		assert.equal(mentionNames("`@jason` and ```\n@jason\n``` and npm i @jason/pkg", handles), "`@jason` and ```\n@jason\n``` and npm i @jason/pkg");
	});

	it("makes valid channel names", () => {
		assert.equal(slackChannelName("Alex Moss_scout"), "alex-moss_scout");
		assert.equal(slackChannelName("Zoë_scout"), "zoe_scout");
	});
});

describe("thread view", () => {
	it("keeps editing a run's message after a restart instead of posting another", async () => {
		const calls: string[] = [];
		const surface = {
			post: async (_c: string, _t: string | undefined, _m: ChatMessage) => {
				calls.push("post");
				return "new";
			},
			update: async (_c: string, ts: string, _m: ChatMessage) => {
				calls.push(`update ${ts}`);
			},
		};
		const remembered: (string | undefined)[] = [];
		const view = new ThreadView({ surface, channel: "C", threadTs: "1", resumeTs: "old", onRunMessage: (ts) => remembered.push(ts) });
		view.handle([{ type: "snapshot", run: {} } as never]);
		view.handle([{ type: "run_end", inputs: [] }]);
		await view.settled();
		view.handle([{ type: "run_start", inputs: [] }]);
		await view.settled();
		assert.deepEqual(calls, ["update old", "update old", "post"]);
		assert.deepEqual(remembered, ["old", undefined, "new"]);
	});
});

describe("answers that always arrive", () => {
	const said = (text: string) => ({ type: "message_end", entry: { model: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }] } }) as never;
	function surface(options: { failUpdate?: boolean; attach?: "ok" | "fail" } = {}) {
		const calls: string[] = [];
		let n = 0;
		return {
			calls,
			post: async (_c: string, _t: string | undefined, m: ChatMessage) => {
				calls.push(`post ${(m.blocks[0] as { text: string }).text.slice(0, 40)}`);
				return `p${++n}`;
			},
			update: async (_c: string, ts: string, m: ChatMessage) => {
				if (options.failUpdate) throw new Error("message_not_found");
				calls.push(`update ${ts} ${(m.blocks[0] as { text: string }).text.slice(0, 40)}`);
			},
			...(options.attach === undefined
				? {}
				: {
						attach: async (_c: string, _t: string, file: { name: string; content: string }) => {
							if (options.attach === "fail") throw new Error("missing_scope");
							calls.push(`attach ${file.name} ${file.content.length}`);
						},
					}),
		};
	}

	it("posts the answer anew when its message can't be edited", async () => {
		const s = surface({ failUpdate: true });
		const ends: (string | undefined)[] = [];
		const view = new ThreadView({ surface: s, channel: "C", threadTs: "1", onRunEnd: (_a, ts) => ends.push(ts) });
		view.handle([{ type: "run_start", inputs: [] }, said("All done."), { type: "run_end", inputs: [] }] as never);
		await view.settled();
		assert.deepEqual(s.calls.map((c) => c.split("\n")[0]), ["post _Working… 0s_", "post All done."]);
		assert.deepEqual(ends, ["p2"], "the answer's own message, for approvals and 🔁");
	});

	/** A surface whose calls (posts and edits, counted together from 1) fail as `fails` says. */
	function flaky(fails: Record<number, "down" | "no">) {
		const calls: string[] = [];
		let n = 0;
		const call = (what: string) => {
			const failure = fails[++n];
			if (failure === "down") throw Object.assign(new Error("connect ECONNREFUSED"), { code: "slack_webapi_request_error" });
			if (failure === "no") throw Object.assign(new Error("not_in_channel"), { code: "slack_webapi_platform_error" });
			calls.push(what);
		};
		return {
			calls,
			post: async (_c: string, _t: string | undefined, m: ChatMessage) => {
				call(`post ${(m.blocks[0] as { text: string }).text.slice(0, 20)}`);
				return `p${n}`;
			},
			update: async (_c: string, ts: string, m: ChatMessage) => call(`update ${ts} ${(m.blocks[0] as { text: string }).text.slice(0, 20)}`),
		};
	}

	it("keeps trying to send the answer while Slack is down, without sending any part twice", async () => {
		// The progress message goes out; Slack is down for the answer's edit and its new post, then for its second part.
		const s = flaky({ 2: "down", 3: "down", 5: "down" });
		const waits: number[] = [];
		const ends: (string | undefined)[] = [];
		const remembered: (string | undefined)[] = [];
		const errors = mock.method(console, "error", () => {});
		const view = new ThreadView({ surface: s, channel: "C", threadTs: "1", onRunEnd: (_a, ts) => ends.push(ts), onRunMessage: (ts) => remembered.push(ts), wait: async (ms) => void waits.push(ms) });
		view.handle([{ type: "run_start", inputs: [] }, said(`First. ${"More. ".repeat(2_500)}`), { type: "run_end", inputs: [] }] as never);
		await view.settled();
		errors.mock.restore();
		assert.deepEqual(waits, [120_000, 120_000], "a wait each time Slack was down");
		assert.deepEqual(s.calls.map((c) => c.split(/\n| More/)[0]), ["post _Working… 0s_", "update p1 First.", "post e."], "the progress message, the answer's first part, then its second");
		assert.deepEqual(ends, ["p1"], "the run counts as answered once it's all in");
		assert.deepEqual(remembered, ["p1", undefined]);
	});

	it("stops trying when Slack says no, and keeps the run's message for a restart to finish", async () => {
		const s = flaky({ 2: "no", 3: "no" });
		const waits: number[] = [];
		const ends: (string | undefined)[] = [];
		const remembered: (string | undefined)[] = [];
		const errors = mock.method(console, "error", () => {});
		const view = new ThreadView({ surface: s, channel: "C", threadTs: "1", onRunEnd: (_a, ts) => ends.push(ts), onRunMessage: (ts) => remembered.push(ts), wait: async (ms) => void waits.push(ms) });
		view.handle([{ type: "run_start", inputs: [] }, said("All done."), { type: "run_end", inputs: [] }] as never);
		await view.settled();
		errors.mock.restore();
		assert.deepEqual(waits, []);
		assert.deepEqual(ends, []);
		assert.deepEqual(remembered, ["p1"], "still remembered: after a restart, it gets the answer");
	});

	it("shows a long answer's opening and attaches the whole of it, or posts it in parts without attachments", async () => {
		const long = `The short version: it works.\n\n${"Details. ".repeat(1500)}`;
		const withFiles = surface({ attach: "ok" });
		let view = new ThreadView({ surface: withFiles, channel: "C", threadTs: "1" });
		view.handle([{ type: "run_start", inputs: [] }, said(long), { type: "run_end", inputs: [] }] as never);
		await view.settled();
		assert.equal(withFiles.calls[1], `attach answer.md ${long.trim().length}`);
		assert.match(withFiles.calls[2]!, /^update p1 The short version: it works\./);

		const without = surface({ attach: "fail" });
		view = new ThreadView({ surface: without, channel: "C", threadTs: "1" });
		view.handle([{ type: "run_start", inputs: [] }, said(long), { type: "run_end", inputs: [] }] as never);
		await view.settled();
		assert.match(without.calls[1]!, /^update p1 The short version/, "the message is the answer's first part, not a promise of a file");
		assert.equal(without.calls.filter((c) => c.startsWith("post")).length, 3, "the progress message, then the rest of the answer");
	});

	it("finishes a message still saying Working… after a restart, with the answer given meanwhile", async () => {
		const s = surface();
		const remembered: (string | undefined)[] = [];
		const view = new ThreadView({ surface: s, channel: "C", threadTs: "1", resumeTs: "old", onRunMessage: (ts) => remembered.push(ts) });
		view.handle([{ type: "snapshot", entries: [{ model: [{ role: "user", content: "fix it" }] }, { model: [{ role: "assistant", content: [{ type: "text", text: "Fixed in #12." }] }] }] } as never]);
		await view.settled();
		assert.deepEqual(s.calls, ["update old Fixed in #12."]);
		assert.deepEqual(remembered, [undefined]);
	});

	it("says it's taking longer, in its own words, and gives up on a run going nowhere", async () => {
		let now = 0;
		const s = surface();
		let slow = 0;
		const view = new ThreadView({ surface: s, channel: "C", threadTs: "1", now: () => now, onSlow: () => slow++, behind: () => true });
		view.handle([{ type: "run_start", inputs: [] }] as never);
		await view.settled();
		assert.ok(SAYINGS.behind.some((line) => s.calls[0]!.includes(line.slice(0, 20))), "warned it's slow today");
		view.handle([{ type: "auto_retry_start", attempt: 1, at: 0, errorMessage: "x" }] as never);
		assert.equal(slow, 1);
		assert.match((progressMessage({ startedAt: 0, steps: [], status: SAYINGS.slow[0] }, 1000).blocks[0] as { text: string }).text, /_Taking a little longer/);
		view.handle([{ type: "tool_execution_start", toolName: "bash", args: { command: "mix test" } }] as never);
		now = 11 * 60_000;
		assert.equal(view.check(now), false);
		now = 90 * 60_000;
		assert.equal(view.check(now), false, "a command still running is work, however long");
		await view.settled();
		view.handle([{ type: "tool_execution_end", toolName: "bash" }] as never);
		now = 140 * 60_000;
		assert.equal(view.check(now), true, "45 minutes with nothing running: stop");
		view.handle([{ type: "run_end", inputs: [] }] as never);
		await view.settled();
		assert.match(s.calls.at(-1)!, /^update p1 I stopped: I hadn't got anywhere in 50 m/, "counted from when the command finished");
	});
});
