import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { startScout } from "./e2e.ts";
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
});
