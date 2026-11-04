import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Crawler, type Page, type Source } from "../src/crawler.ts";
import { History } from "../src/history.ts";

const doc = (id: string, text: string) => ({ id, source: "fake", kind: "message", thread: "T:1", conversationId: 1, channel: "c", text });

/** A source of numbered pages; `fail` makes it throw before the page with that number. */
function fake(name: string, pages: number, options: { fail?: number; scopes?: string[] } = {}): Source & { asked: (string | undefined)[] } {
	const asked: (string | undefined)[] = [];
	return {
		name,
		asked,
		...(options.scopes === undefined ? {} : { scopes: () => options.scopes! }),
		async *crawl(scope, cursor): AsyncGenerator<Page> {
			asked.push(`${scope}:${cursor}`);
			for (let n = cursor === undefined ? 1 : Number(cursor) + 1; n <= pages; n++) {
				if (n === options.fail) throw new Error(`page ${n} was refused`);
				yield { docs: [doc(`${name}:${scope}:${n}`, `${name} ${scope} page ${n} words`)], links: [{ from: `${name}:${scope}:${n}`, to: "x", rel: "mentions", source: name }], cursor: String(n) };
			}
		},
	};
}

describe("crawler", () => {
	it("stores each page with the cursor it reached, and asks from there next time", async () => {
		const history = new History(":memory:");
		const source = fake("fake", 3);
		const crawler = new Crawler({ history, sources: [source] });
		const [status] = await crawler.runOnce();
		assert.equal(status?.written, 3);
		assert.equal(history.cursor("fake"), "3");
		await crawler.runOnce({ force: true });
		assert.deepEqual(source.asked, [":undefined", ":3"]);
		assert.equal(history.search("page").length, 1, "one thread, however many pages");
		assert.equal(history.stats()[0]?.documents, 3);
	});

	it("keeps the pages it stored when a source fails part-way, and carries on from there", async () => {
		const history = new History(":memory:");
		let now = 1_000_000;
		const logs: string[] = [];
		const failing = fake("fake", 4, { fail: 3 });
		const crawler = new Crawler({ history, sources: [failing], now: () => now, log: (m) => logs.push(m), everyMs: 60_000 });
		let [status] = await crawler.runOnce();
		assert.match(status!.error ?? "", /page 3 was refused/);
		assert.equal(status!.failures, 1);
		assert.equal(history.cursor("fake"), "2", "the pages before the failure are kept");
		assert.equal(history.stats()[0]?.documents, 2);
		assert.equal(logs.length, 1);

		// Not due yet: asked again after the interval, doubled for the failure.
		[status] = await crawler.runOnce();
		assert.equal(failing.asked.length, 1);
		now += 119_000;
		await crawler.runOnce();
		assert.equal(failing.asked.length, 1, "still backing off");
		now += 2_000;
		[status] = await crawler.runOnce();
		assert.equal(failing.asked.length, 2);
		assert.equal(status!.failures, 2);
		assert.equal(logs.length, 1, "the same failure is said once");
		assert.equal(failing.asked[1], ":2", "from the cursor, not the start");
	});

	it("goes on to the next source when one fails, and says when the failing one recovers", async () => {
		const history = new History(":memory:");
		let broken = true;
		const logs: string[] = [];
		const flaky: Source = { name: "flaky", async *crawl() { if (broken) throw new Error("down"); yield { docs: [doc("flaky:1", "recovered words")], cursor: "1" }; } };
		const steady = fake("steady", 1);
		let now = 0;
		const crawler = new Crawler({ history, sources: [flaky, steady], now: () => now, log: (m) => logs.push(m) });
		const first = await crawler.runOnce();
		assert.equal(first.find((s) => s.source === "steady")?.written, 1, "the other source was crawled");
		assert.equal(first.find((s) => s.source === "flaky")?.failures, 1);
		broken = false;
		const second = await crawler.runOnce({ force: true });
		assert.equal(second.find((s) => s.source === "flaky")?.error, undefined);
		assert.equal(second.find((s) => s.source === "flaky")?.failures, 0);
		assert.deepEqual(logs, ["flaky: crawling failed (down); trying again later", "flaky: crawling works again"]);
	});

	it("keeps a cursor for each of a source's scopes", async () => {
		const history = new History(":memory:");
		const source = fake("forge", 2, { scopes: ["a/b", "c/d"] });
		await new Crawler({ history, sources: [source] }).runOnce();
		assert.equal(history.cursor("forge", "a/b"), "2");
		assert.equal(history.cursor("forge", "c/d"), "2");
		assert.equal(history.stats()[0]?.documents, 4);
		assert.equal(history.search({ text: "page", limit: 5 }).length, 1);
	});

	it("starts nothing once stopped", async () => {
		const history = new History(":memory:");
		const source = fake("fake", 1);
		const crawler = new Crawler({ history, sources: [source] });
		await crawler.runOnce();
		await crawler.stop();
		await crawler.runOnce({ force: true });
		assert.deepEqual(source.asked, [":undefined"], "the second run asked nothing");
	});

	it("loses and repeats nothing when stopped between pages and started again", async () => {
		const history = new History(":memory:");
		const inner = fake("fake", 3);
		let crawler: Crawler;
		const stopping: Source = {
			...inner,
			async *crawl(scope, cursor, signal) {
				for await (const page of inner.crawl(scope, cursor, signal)) {
					if (page.cursor === "1") void crawler.stop(); // stopped while the first page is in flight
					yield page;
				}
			},
		};
		crawler = new Crawler({ history, sources: [stopping] });
		await crawler.runOnce();
		assert.equal(history.cursor("fake"), "1", "the page in flight was stored, the rest were not asked for");
		assert.equal(history.stats()[0]?.documents, 1);
		const again = new Crawler({ history, sources: [inner] });
		await again.runOnce();
		assert.equal(history.cursor("fake"), "3");
		assert.equal(history.stats()[0]?.documents, 3, "pages 2 and 3 came after the cursor, page 1 wasn't repeated");
		assert.deepEqual(inner.asked, [":undefined", ":1"], "the second crawl began after the stored cursor");
	});
});
