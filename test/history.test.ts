import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunks, History } from "../src/history.ts";

let n = 0;
const put = (h: History, thread: string, who: string, text: string, extra: Partial<Parameters<History["put"]>[0]> = {}) =>
	h.put({ id: `slack:message:${thread}:${++n}`, source: "slack", kind: "message", thread, conversationId: Number(thread.split(":")[1]), channel: "deploys", authorName: who, text, ...extra });

describe("history search", () => {
	const history = new History(":memory:");
	put(history, "C1:1", "ann", "The staging deploy is failing with a certificate error");
	put(history, "C1:1", "Scout", "The certificate expired; renewing it with certbot fixed staging deploys.");
	put(history, "C1:2", "bob", "How do I run the checkout tests locally?");
	put(history, "C1:3", "cat", "Deploying to production needs the release role");

	it("finds threads by meaning-ish words, one hit per thread", () => {
		const hits = history.search("certificate deploying staging");
		assert.deepEqual(hits.map((h) => h.key), ["C1:1"]);
		assert.match(hits[0]!.snippet, /\*certificate\*/i);
	});

	it("falls back to any word when no thread has them all", () => {
		assert.deepEqual(history.search("deploy tests").map((h) => h.key).sort(), ["C1:1", "C1:2", "C1:3"]);
	});

	it("leaves out the current thread and survives query syntax", () => {
		assert.deepEqual(history.search("certificate", { excludeThread: "C1:1" }), []);
		assert.deepEqual(history.search('checkout" OR (tests*'), history.search("checkout tests"));
		assert.deepEqual(history.search("!!!"), []);
	});
});

describe("history store", () => {
	it("puts a document once: the same text is skipped, changed text replaces it, secrets never get in", () => {
		const h = new History(":memory:");
		const doc = { id: "forge:pull:a/b#1", source: "forge", kind: "pull", repo: "a/b", author: "u1", authorName: "Mary", title: "Cache the lookup", text: "Adds a cache" };
		assert.equal(h.put(doc), true);
		assert.equal(h.put(doc), false, "unchanged");
		assert.equal(h.put({ ...doc, text: "Adds a cache with a token ghp_" + "a".repeat(36) }), true, "changed");
		assert.equal(h.search("cache").length, 1, "one document, not two");
		assert.equal(h.search("ghp_" + "a".repeat(36)).length, 0, "the secret was redacted before it was stored");
		assert.equal(h.search("redacted").length, 1);
		assert.equal(h.search("lookup")[0]?.kind, "pull", "the title is searched");
	});

	it("filters by person, repository, source, kind and date", () => {
		const h = new History(":memory:");
		const base = { source: "slack", kind: "message", channel: "x", text: "the build is slow today" };
		h.put({ ...base, id: "a", thread: "T:1", conversationId: 1, author: "U1", authorName: "Mary", repo: "r/one", at: 1000 });
		h.put({ ...base, id: "b", thread: "T:2", conversationId: 2, author: "U2", authorName: "Sam", repo: "r/two", at: 2000 });
		h.put({ ...base, id: "c", source: "forge", kind: "review", thread: "T:3", conversationId: 3, author: "U2", authorName: "Sam", repo: "r/two", at: 3000 });
		const keys = (q: object) => h.search({ text: "build", ...q }).map((x) => x.key).sort();
		assert.deepEqual(keys({}), ["T:1", "T:2", "T:3"]);
		assert.deepEqual(keys({ person: "U2" }), ["T:2", "T:3"]);
		assert.deepEqual(keys({ repo: "r/one" }), ["T:1"]);
		assert.deepEqual(keys({ source: "forge" }), ["T:3"]);
		assert.deepEqual(keys({ kind: "message", since: 1500 }), ["T:2"]);
		assert.deepEqual(keys({ until: 1500 }), ["T:1"]);
		assert.deepEqual(h.people("mar"), [{ id: "U1", name: "Mary" }]);
	});

	it("gives a document that only had a name to the person once their id is known", () => {
		const h = new History(":memory:");
		h.put({ id: "old", source: "slack", kind: "message", authorName: "Mary", text: "earlier words about rollbacks" });
		assert.equal(h.search({ text: "rollbacks", person: "U1" }).length, 0);
		h.put({ id: "new", source: "slack", kind: "message", author: "U1", authorName: "Mary", text: "later words" });
		assert.equal(h.search({ text: "rollbacks", person: "U1" }).length, 1);
	});

	it("forgets a thread's documents and what links to them, and only that thread's", () => {
		const h = new History(":memory:");
		put(h, "C1:1", "ann", "alpha words");
		put(h, "C1:2", "bob", "alpha words too");
		h.link({ from: "slack:thread:C1:1", to: "forge:pull:a/b#1", rel: "opened", source: "slack" });
		h.forget("C1:1");
		assert.deepEqual(h.search("alpha").map((x) => x.key), ["C1:2"]);
		assert.equal(h.first(1), undefined);
		assert.equal(h.first(2)?.text, "alpha words too");
	});

	it("keeps where a crawl stopped, per source and scope", () => {
		const h = new History(":memory:");
		assert.equal(h.cursor("forge", "a/b"), undefined);
		h.setCursor("forge", "2026-11-01", "a/b");
		h.setCursor("forge", "x", "c/d");
		assert.equal(h.cursor("forge", "a/b"), "2026-11-01");
		h.setCursor("forge", "2026-11-02", "a/b");
		assert.equal(h.cursor("forge", "a/b"), "2026-11-02");
		assert.deepEqual(h.stats(), []);
	});

	it("cuts long text into overlapping chunks that still find a word near the end", () => {
		const text = Array.from({ length: 400 }, (_, i) => `sentence number ${i} about nothing much.`).join(" ") + " Finally the zebrafish appears.";
		const parts = chunks(text);
		assert.ok(parts.length > 1);
		assert.ok(parts.every((p) => p.length <= 3300));
		assert.equal(chunks("short").length, 1);
		const h = new History(":memory:");
		h.put({ id: "long", source: "slack", kind: "message", thread: "C:9", conversationId: 9, text });
		assert.equal(h.search("zebrafish").length, 1);
	});
});

describe("history migration", () => {
	it("brings Scout 1's search table across once, with people matched by name later", () => {
		const dir = mkdtempSync(join(tmpdir(), "history-"));
		const path = join(dir, "scout.sqlite");
		const old = new DatabaseSync(path);
		old.exec(`CREATE VIRTUAL TABLE thread_text USING fts5(key UNINDEXED, conversation_id UNINDEXED, channel_name UNINDEXED, speaker UNINDEXED, at UNINDEXED, text, tokenize = 'porter unicode61')`);
		const add = old.prepare("INSERT INTO thread_text (key, conversation_id, channel_name, speaker, at, text) VALUES (?, ?, ?, ?, ?, ?)");
		add.run("C1:1.1", 7, "deploys", "ann", 5000, "the staging certificate expired");
		add.run("C1:1.1", 7, "deploys", "Scout", 6000, "renewed the certificate");
		old.close();
		const h = new History(path);
		const hits = h.search("certificate");
		assert.deepEqual(hits.map((x) => [x.key, x.conversationId, x.channelName]), [["C1:1.1", 7, "deploys"]]);
		assert.equal(h.first(7)?.text, "the staging certificate expired");
		h.close();
		const again = new History(path);
		assert.equal(again.search("certificate").length, 1, "opening again changes nothing");
		assert.equal(again.stats()[0]?.documents, 2);
		assert.equal(new DatabaseSync(path).prepare("SELECT 1 FROM sqlite_master WHERE name = 'thread_text'").get(), undefined, "the old table is gone");
		again.close();
	});
});
