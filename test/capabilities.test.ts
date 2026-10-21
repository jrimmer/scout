import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Capabilities } from "../src/capabilities.ts";
import { parseCodeLink, previewBlocks } from "../src/previews.ts";

const DAY = 24 * 60 * 60 * 1000;

describe("what the workspace allows", () => {
	it("says which features are off for want of a scope, and which are on", () => {
		const c = new Capabilities(":memory:");
		c.granted(["chat:write", "files:write", "commands", "lists:write"]);
		assert.equal(c.on("attachments"), true);
		assert.match(c.off("reactions") ?? "", /needs the reactions:write scope: update the app from slack-manifest.yaml and reinstall/);
		assert.match(c.off("unfurls") ?? "", /links:read and links:write scopes/);
		const summary = c.summary();
		assert.ok(summary.includes("Slack: long answers attached in full: on"));
		assert.ok(summary.some((line) => /^Slack: 👀\/✅\/⚠️ on requests: off, needs/.test(line)));
		c.close();
	});

	it("learns from the first call that the plan doesn't allow a feature, logs it once, and tries again the next day", async () => {
		const c = new Capabilities(":memory:");
		c.granted(["lists:write"]);
		const logged: string[] = [];
		const refused = () => Promise.reject(Object.assign(new Error("An API error occurred: paid_teams_only"), { data: { error: "paid_teams_only" } }));
		assert.equal(await c.use("lists", refused, (l) => logged.push(l), 0), undefined);
		assert.equal(await c.use("lists", refused, (l) => logged.push(l), 1), undefined, "off now: not even tried");
		assert.deepEqual(logged, ["Slack: the list of Scout's work is off: this workspace doesn't allow it (paid_teams_only). I'll try again tomorrow."]);
		assert.equal(await c.use("lists", async () => "made", (l) => logged.push(l), DAY + 1), "made", "a day later it tries again, and it works");
		assert.equal(c.on("lists", DAY + 2), true);
		await assert.rejects(c.use("lists", () => Promise.reject(new Error("ratelimited")), () => {}, DAY + 3), /ratelimited/, "a passing failure isn't taken for the plan");
		c.close();
	});
});

describe("link previews", () => {
	it("reads Forgejo and GitHub links, and shows where things stand and whether Scout's on it", () => {
		assert.deepEqual(parseCodeLink("https://code.lacy.casa/jrimmer/scout-playground/pulls/10"), { slug: "jrimmer/scout-playground", number: 10, pull: true });
		assert.deepEqual(parseCodeLink("https://github.com/o/r/pull/3"), { slug: "o/r", number: 3, pull: true });
		assert.deepEqual(parseCodeLink("https://code.lacy.casa/o/r/issues/9"), { slug: "o/r", number: 9, pull: false });
		assert.equal(parseCodeLink("https://code.lacy.casa/o/r/src/branch/main"), undefined);
		const blocks = JSON.stringify(
			previewBlocks({ url: "https://h/o/r/pulls/10", slug: "o/r", number: 10, title: "README: <tests>", pull: true, state: "open", author: "scout", ci: "passing", reviewers: ["jrimmer"], scout: { link: "https://slack/t", working: false } }),
		);
		assert.match(blocks, /\*<https:\/\/h\/o\/r\/pulls\/10\|o\/r#10>\* README: &lt;tests&gt;/);
		assert.match(blocks, /🟢 open · by scout · ✅ CI passing · waiting on review from jrimmer/);
		assert.match(blocks, /Scout has a thread on this: <https:\/\/slack\/t\|open it>/);
	});
});
