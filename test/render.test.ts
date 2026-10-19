import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { delivery } from "../src/etiquette.ts";
import { frontmatter } from "../src/profile.ts";
import { describeStep, finalMessage, progressMessage } from "../src/render.ts";
import { slackChannelName } from "../src/slack.ts";

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

	it("says what went wrong when a run fails without an answer", () => {
		const message = finalMessage({ startedAt: 0, steps: [], error: "model overloaded" }, 1000);
		assert.match(message.text, /ran into a problem.*model overloaded/);
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
	it("parses skill frontmatter", () => {
		assert.deepEqual(frontmatter("---\ndescription: Query the warehouse\n---\nBody"), {
			meta: { description: "Query the warehouse" },
			body: "Body",
		});
		assert.deepEqual(frontmatter("No frontmatter"), { meta: {}, body: "No frontmatter" });
	});

	it("makes valid channel names", () => {
		assert.equal(slackChannelName("Jason Rimmer_scout"), "jason-rimmer_scout");
		assert.equal(slackChannelName("Zoë_scout"), "zoe_scout");
	});
});
