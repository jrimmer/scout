import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { delivery } from "../src/etiquette.ts";
import { frontmatter } from "../src/profile.ts";
import { type ChatMessage, describeStep, finalMessage, progressMessage, ThreadView } from "../src/render.ts";
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
		assert.equal(slackChannelName("Jason Rimmer_scout"), "jason-rimmer_scout");
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
		assert.deepEqual(remembered, [undefined, "new"]);
	});
});
