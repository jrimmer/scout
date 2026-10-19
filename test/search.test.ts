import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ThreadSearch } from "../src/search.ts";

describe("thread search", () => {
	const search = new ThreadSearch(":memory:");
	const add = (key: string, speaker: string, text: string) =>
		search.add({ key, conversationId: Number(key.split(":")[1]), channelName: "deploys", speaker, text });
	add("C1:1", "ann", "The staging deploy is failing with a certificate error");
	add("C1:1", "Scout", "The certificate expired; renewing it with certbot fixed staging deploys.");
	add("C1:2", "bob", "How do I run the checkout tests locally?");
	add("C1:3", "cat", "Deploying to production needs the release role");

	it("finds threads by meaning-ish words, one hit per thread", () => {
		const hits = search.search("certificate deploying staging");
		assert.deepEqual(hits.map((h) => h.key), ["C1:1"]);
		assert.match(hits[0]!.snippet, /\*certificate\*/i);
	});

	it("falls back to any word when no thread has them all", () => {
		assert.deepEqual(search.search("deploy tests").map((h) => h.key).sort(), ["C1:1", "C1:2", "C1:3"]);
	});

	it("leaves out the current thread and survives query syntax", () => {
		assert.deepEqual(search.search("certificate", { excludeKey: "C1:1" }), []);
		assert.deepEqual(search.search('checkout" OR (tests*'), search.search("checkout tests"));
		assert.deepEqual(search.search("!!!"), []);
	});
});
