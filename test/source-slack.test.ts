import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { Crawler } from "../src/crawler.ts";
import { History } from "../src/history.ts";
import { answerId, slackSource, threadDocs } from "../src/source-slack.ts";
import { Threads } from "../src/threads.ts";

let n = 0;
const entry = (kind: string, extra: object): EntryRecord => ({ id: `e${++n}`, conversationId: 7, kind, ...extra }) as unknown as EntryRecord;
const said = (ts: string, user: string, name: string, text: string) => entry("slack.message", { data: { user, name, text, ts } });
const asks = (id: string, name: string, args: object) => entry("pi.assistant", { model: [{ role: "assistant", timestamp: 1_700_000_100_000, content: [{ type: "text", text: "Looking." }, { type: "toolCall", id, name, arguments: args }] }] });
const result = (id: string, text: string, isError = false) => entry("pi.tool-result", { model: [{ role: "toolResult", toolCallId: id, toolName: "bash", isError, content: [{ type: "text", text }] }] });
const replies = (text: string) => entry("pi.assistant", { model: [{ role: "assistant", timestamp: 1_700_000_200_000, content: [{ type: "text", text }] }] });

const thread = { key: "C1:1700000000.000100", conversationId: 7 };
const entries = [
	said("1700000000.000100", "U1", "Mary", "why is the staging build slow?"),
	asks("t1", "bash", { command: "npm run build -- --profile" }),
	result("t1", "built in 212s; the tsc step took 190s"),
	asks("t2", "bash", { command: "cat /etc/secret" }),
	result("t2", "token ghp_" + "b".repeat(36), true),
	replies("The type check dominates the build."),
];

describe("slack documents", () => {
	const docs = threadDocs(thread, "deploys", entries);

	it("has what people said, what Scout answered, and what it ran", () => {
		assert.deepEqual(docs.map((d) => [d.kind, d.author, d.id.split(":")[1]]), [
			["message", "U1", "message"],
			["message", "scout", "answer"], // "Looking." beside the first call
			["tool", "scout", "tool"],
			["message", "scout", "answer"], // "Looking." again: same words, same id
			["tool", "scout", "tool"],
			["message", "scout", "answer"],
		]);
		const mary = docs[0]!;
		assert.equal(mary.id, "slack:message:C1:1700000000.000100:1700000000.000100");
		assert.equal(mary.at, 1_700_000_000_000);
		assert.equal(mary.conversationId, 7);
		assert.equal(mary.channel, "deploys");
	});

	it("keeps a tool call with the start of its result, and says when it failed", () => {
		const tools = docs.filter((d) => d.kind === "tool");
		assert.equal(tools[0]!.text, "bash npm run build -- --profile\n→ built in 212s; the tsc step took 190s");
		assert.match(tools[1]!.text, /^bash cat \/etc\/secret\nfailed: token ghp_/);
	});

	it("is stored once however often it is read, and never with a secret", () => {
		const history = new History(":memory:");
		for (let i = 0; i < 3; i++) history.putAll(docs);
		assert.equal(history.stats()[0]?.documents, 5, "the repeated 'Looking.' is one document");
		assert.equal(history.search({ text: "ghp_" + "b".repeat(36), kind: "tool" }).length, 0);
		assert.equal(history.search({ text: "redacted", kind: "tool" }).length, 1);
	});

	it("leaves what Scout ran out of an ordinary search, and finds it when asked for", () => {
		const history = new History(":memory:");
		history.putAll(docs);
		assert.deepEqual(history.search("profile").map((h) => h.kind), [], "'profile' is only in a tool call");
		assert.equal(history.search({ text: "profile", kind: "tool" })[0]?.kind, "tool");
		assert.equal(history.search("staging")[0]?.speaker, "Mary");
		assert.equal(history.search({ text: "type check", person: "U1" }).length, 0, "Scout said it, not Mary");
	});

	it("gives a live reply the same id as the crawl does", () => {
		const text = "The type check dominates the build.";
		assert.equal(docs.at(-1)!.id, answerId(thread.key, `  ${text}\n`));
	});
});

describe("slack source", () => {
	function setup() {
		const threads = new Threads(":memory:");
		for (const [i, ts] of ["100.1", "200.1", "300.1"].entries()) {
			threads.insert({ key: `C1:${ts}`, conversationId: 10 + i, channel: "C1", threadTs: ts, startedBy: "U1" }, 1000 * (i + 1));
		}
		const reads: number[] = [];
		const source = slackSource({
			threads,
			pageSize: 2,
			read: async (t) => {
				reads.push(t.conversationId);
				if (t.conversationId === 11) return undefined; // its conversation is gone
				return { channel: "deploys", entries: [said(t.threadTs, "U1", "Mary", `request ${t.conversationId} about caches`)] };
			},
		});
		return { threads, source, reads };
	}

	it("reads every thread once, in pages, and later only the threads with new activity", async () => {
		const history = new History(":memory:");
		const { threads, source, reads } = setup();
		const crawler = new Crawler({ history, sources: [source] });
		const [first] = await crawler.runOnce();
		assert.equal(first?.written, 2, "the thread without a conversation is skipped");
		assert.equal(history.cursor("slack"), "3000");
		reads.length = 0;
		threads.spoke("C1:100.1", "U1", 5000);
		await crawler.runOnce({ force: true });
		assert.deepEqual(reads, [12, 10], "from the cursor: the newest thread read again, and the one that just spoke");
		assert.equal(history.search({ text: "caches", person: "U1" }).length, 2);
	});

	it("doesn't bring back a thread retention cleared", async () => {
		const history = new History(":memory:");
		const { threads, source, reads } = setup();
		threads.purged("C1:100.1", 4000);
		await new Crawler({ history, sources: [source] }).runOnce();
		assert.deepEqual(reads, [11, 12], "the cleared thread (10) is not read; 11 has no conversation left");
		assert.equal(history.stats()[0]!.documents, 1);
		assert.equal(history.search({ text: "caches", person: "U1" }).length, 1);
	});
});
