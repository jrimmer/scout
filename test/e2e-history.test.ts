import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { threadKey } from "../src/threads.ts";
import { HELD_AFTER_MS } from "../src/history.ts";
import { startScout } from "./e2e.ts";
import { TEAM_CHANNEL } from "./fake-slack.ts";
import { until } from "./helpers.ts";

const toolUse = { stopReason: "toolUse" } as const;

/** The session index as the service runs it: filled live by the bridge, completed by the crawl on the housekeeping tick. */
describe("end to end: the session index", () => {
	it("finds what was said at once, adds what Scout ran after a crawl, and holds each answer once", async () => {
		const e2e = await startScout();
		const answer = "The greeting came from the shell, so the sandbox runs commands.";
		e2e.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "echo zxqv7token" })], toolUse),
			fauxAssistantMessage(answer),
		]);
		try {
			await e2e.mention("can the sandbox run commands? try echoing a greeting");
			await until(() => e2e.said().some((t) => t.includes(answer)), 20_000, "the answer");
			await e2e.service.scout.harness.waitForIdle(context);
			const history = e2e.service.scout.history;

			// Live, before any crawl: the request and the answer, not what the agent ran.
			assert.equal(history.search("sandbox commands").length, 1);
			assert.equal(history.search({ text: "zxqv7token", kind: "tool" }).length, 0, "not crawled yet");

			await e2e.service.tick.housekeeping();
			const found = history.search({ text: "zxqv7token", kind: "tool" });
			assert.equal(found.length, 1, "the crawl read the tool call from the conversation");
			assert.equal(history.search("zxqv7token").length, 0, "an ordinary search leaves tool calls out");

			// The live answer and the crawled one are the same document.
			await e2e.service.tick.housekeeping();
			const db = new DatabaseSync(join(e2e.env.SCOUT_DATA_DIR!, "scout.sqlite"), { readOnly: true });
			try {
				const answers = db.prepare("SELECT count(*) AS n FROM history_docs WHERE id LIKE 'slack:answer:%'").get() as { n: number };
				assert.equal(answers.n, 1, "stored once, however often it is read");
			} finally {
				db.close();
			}
		} finally {
			await e2e.close();
		}
	});

	it("leaves the asking thread out of what search_threads finds", async () => {
		const e2e = await startScout();
		let seen = "";
		e2e.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("search_threads", { query: "zebra stripes" })], toolUse),
			(transcript) => {
				seen = JSON.stringify(transcript);
				return fauxAssistantMessage("Nothing earlier on that.");
			},
		]);
		try {
			await e2e.mention("why do zebra stripes confuse the linter?");
			await until(() => e2e.said().some((t) => t.includes("Nothing earlier on that.")), 20_000, "the answer");
			await e2e.service.scout.harness.waitForIdle(context);
			assert.ok(e2e.service.scout.history.search("zebra stripes").length === 1, "the request is in the index");
			assert.match(seen, /No earlier threads match\./, "but not found by its own thread");
		} finally {
			await e2e.close();
		}
	});

	it("tells whether the pull request a thread opened held, from the code host", async () => {
		const clock = { time: Date.now() };
		const e2e = await startScout({ now: () => clock.time });
		const { host, faux } = e2e;
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "printf 'Be kind.\\n' > CONTRIBUTING.md && git add CONTRIBUTING.md && git commit -qm 'Add a contributing guide'" })], toolUse),
			fauxAssistantMessage([fauxToolCall("open_pull_request", { title: "Add a contributing guide", body: "Adds CONTRIBUTING.md." })], toolUse),
			fauxAssistantMessage("APPROVE\nSmall and right."),
			fauxAssistantMessage("I opened a pull request that adds CONTRIBUTING.md."),
		]);
		try {
			const ts = await e2e.mention("please add a CONTRIBUTING.md");
			await until(() => e2e.said().some((t) => t.includes("I opened a pull request that adds CONTRIBUTING.md.")), 20_000, "the answer");
			await e2e.service.scout.harness.waitForIdle(context);
			const key = threadKey(TEAM_CHANNEL, ts);
			const history = e2e.service.scout.history;
			const verdict = (at = clock.time) => history.outcome(key, at).verdict;
			assert.equal(verdict(), "none", "before the code host has been read");

			await e2e.service.tick.housekeeping();
			assert.equal(verdict(), "open");
			assert.equal(history.search({ text: "CONTRIBUTING", source: "forge" })[0]?.kind, "pull");

			host.merge("acme/app", 1);
			clock.time += 10 * 60_000;
			await e2e.service.tick.housekeeping();
			assert.equal(verdict(), "merged", "merged, too soon to say");
			assert.equal(verdict(clock.time + HELD_AFTER_MS), "held", "and later, it held");

			// Someone reverts it.
			const revert = host.pull("acme/app", { title: 'Revert "Add a contributing guide (#1)"', head: "revert-1", author: "ann" });
			host.merge("acme/app", revert);
			clock.time += 10 * 60_000;
			await e2e.service.tick.housekeeping();
			assert.equal(verdict(clock.time + HELD_AFTER_MS), "reverted");
			assert.equal(history.outcome(key).pulls[0]?.by, `forge:item:acme/app#${revert}`);
		} finally {
			await e2e.close();
		}
	});
});
