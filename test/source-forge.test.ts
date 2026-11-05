import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { Crawler } from "../src/crawler.ts";
import { forgeFor, TooManyChanges } from "../src/forge.ts";
import { History, threadRef } from "../src/history.ts";
import { forgeSource, itemId, linkLogins, linksIn } from "../src/source-forge.ts";
import { fakeCodeHost } from "./fake-codehost.ts";

const SLUG = "acme/app";
const DAY = 24 * 60 * 60 * 1000;

describe("links in a description", () => {
	const links = (title: string, body: string, pull = true) => linksIn(SLUG, { number: 50, title, body, pull, createdAt: 1 }, itemId(SLUG, 50)).map((l) => `${l.rel} ${l.to.replace("forge:item:", "")}`);

	it("reads the words that close, revert and build on", () => {
		assert.deepEqual(links("Fix the cache", "Fixes #12 and closes acme/lib#3."), ["closes acme/app#12", "closes acme/lib#3"]);
		assert.deepEqual(links('Revert "Add the cache (#40)"', "This reverts the change."), ["reverts acme/app#40"]);
		assert.deepEqual(links("Next step", "Builds on #8. Follow-up to #9."), ["builds_on acme/app#8", "builds_on acme/app#9"]);
	});

	it("counts a plain number as a mention, once, and not itself, a url fragment or another word's tail", () => {
		assert.deepEqual(links("Look", "See #7, #7 again, #50 (this), https://x.dev/page#99 and abc#98.").sort(), ["mentions acme/app#7"]);
		assert.deepEqual(links("Fix", "Fixes #12, see also #12 and #13").sort(), ["closes acme/app#12", "mentions acme/app#13"]);
	});

	it("doesn't take other talk of reverting for a revert", () => {
		assert.deepEqual(links("Fix revert flow (#40)", "Adds a revert button. Related to #40."), ["mentions acme/app#40"]);
		assert.deepEqual(links("Undo button", "Reverts #12\nSee also #13").sort(), ["mentions acme/app#13", "reverts acme/app#12"]);
	});

	it("doesn't call an issue a revert", () => {
		assert.deepEqual(links("Revert the redesign", "Reverts #4", false), ["mentions acme/app#4"]);
	});
});

describe("the code host source", () => {
	const hosts: Awaited<ReturnType<typeof fakeCodeHost>>[] = [];
	after(async () => {
		for (const h of hosts) await h.close();
	});

	async function setup(clock = { time: Date.now() }) {
		const host = await fakeCodeHost();
		hosts.push(host);
		host.repo(SLUG);
		const forge = forgeFor({ kind: "forgejo", apiUrl: host.apiUrl, token: "t" });
		const history = new History(":memory:");
		const opened = new Map<string, string>();
		const source = forgeSource({ forge, repos: () => [SLUG], threadOf: (slug, n) => opened.get(`${slug}#${n}`), pageSize: 2, now: () => clock.time });
		return { host, forge, history, source, opened, clock, crawler: new Crawler({ history, sources: [source], now: () => clock.time }) };
	}

	it("indexes pull requests, issues, and what was said on them, as the people who said it", async () => {
		const { host, history, crawler } = await setup();
		const pr = host.pull(SLUG, { title: "Cache the lookups", head: "cache", author: "mjones", body: "Speeds up the staging build." });
		host.issue(SLUG, { title: "Staging build is slow", body: "It takes ten minutes.", author: "ann" });
		host.review(SLUG, pr, "bsmith", "REQUEST_CHANGES", "The cache never expires.", [{ path: "src/cache.ts", line: 4, body: "Add a TTL here." }]);
		host.comment(SLUG, pr, "mjones", "Added a TTL.", false);
		await crawler.runOnce();

		const found = history.search({ text: "staging", source: "forge" });
		assert.deepEqual(found.map((h) => [h.kind, h.speaker]).sort(), [["issue", "ann"], ["pull", "mjones"]]);
		assert.equal(history.search({ text: "TTL", person: "forge:bsmith" })[0]?.kind, "comment", "bsmith's line comment");
		assert.equal(history.search({ text: "TTL", repo: SLUG })[0]?.key, itemId(SLUG, pr), "comments on a pull request are found as that pull request");
		assert.equal(history.search({ text: "never expires", kind: "review" })[0]?.speaker, "bsmith");
	});

	it("carries on from where it stopped, and sees a pull request again when it changes", async () => {
		const { host, history, crawler, clock } = await setup();
		const pr = host.pull(SLUG, { title: "Cache the lookups", head: "cache", author: "mjones", body: "Speeds up the build." });
		host.times(SLUG, pr, { createdAt: new Date(clock.time - 3 * DAY).toISOString(), updatedAt: new Date(clock.time - 3 * DAY).toISOString() });
		await crawler.runOnce();
		const cursor = history.cursor("forge", SLUG);
		assert.equal(cursor, String(clock.time - 3 * DAY));
		const calls = host.calls.length;
		await crawler.runOnce({ force: true });
		assert.ok(host.calls.length > calls, "asked again");
		assert.equal(history.stats().find((s) => s.source === "forge")?.documents, 1, "and found nothing new");

		host.merge(SLUG, pr);
		await crawler.runOnce({ force: true });
		assert.equal(history.stats().find((s) => s.source === "forge")?.documents, 1, "the same document, now merged");
		assert.notEqual(history.cursor("forge", SLUG), cursor);
	});

	it("starts a first crawl at the backfill window, not at the beginning", async () => {
		const { host, history, crawler, clock } = await setup();
		const old = host.issue(SLUG, { title: "Ancient news", author: "ann" });
		host.times(SLUG, old, { createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2020-01-01T00:00:00.000Z" });
		host.issue(SLUG, { title: "Recent news", author: "ann" });
		await crawler.runOnce();
		assert.equal(history.search({ text: "recent" }).length, 1);
		assert.equal(history.search({ text: "ancient" }).length, 0, "from before the window");
	});

	it("says what became of a thread's pull request: reverted, fixed, held, or still open", async () => {
		const { host, history, crawler, opened, clock } = await setup();
		const ago = (days: number) => new Date(clock.time - days * DAY).toISOString();
		const make = (title: string, extra: { body?: string; merged?: number } = {}) => {
			const n = host.pull(SLUG, { title, head: title.replace(/\W+/g, "-"), author: "scout", ...(extra.body === undefined ? {} : { body: extra.body }) });
			if (extra.merged !== undefined) {
				host.merge(SLUG, n);
				host.times(SLUG, n, { createdAt: ago(extra.merged + 1), updatedAt: ago(extra.merged), mergedAt: ago(extra.merged), closedAt: ago(extra.merged) });
			}
			return n;
		};
		const reverted = make("Add the cache", { merged: 20 });
		const fixed = make("Add retries", { merged: 20 });
		const held = make("Add logging", { merged: 20 });
		const recent = make("Add metrics", { merged: 1 });
		const open = make("Add tracing");
		const closed = make("Add profiling");
		host.closePull(SLUG, closed);
		make(`Revert "Add the cache (#${reverted})"`, { merged: 15 });
		make("Handle the retry loop", { body: `Fixes #${fixed}`, merged: 10 });
		make("Use the logger in jobs", { body: `Builds on #${held}`, merged: 9 });
		for (const [thread, n] of [["C1:reverted", reverted], ["C1:fixed", fixed], ["C1:held", held], ["C1:recent", recent], ["C1:open", open], ["C1:closed", closed]] as const) opened.set(`${SLUG}#${n}`, thread);
		await crawler.runOnce();

		const verdict = (thread: string) => history.outcome(thread, clock.time);
		assert.equal(verdict("C1:reverted").verdict, "reverted");
		assert.equal(verdict("C1:reverted").pulls[0]?.by, itemId(SLUG, reverted + 6));
		assert.equal(verdict("C1:fixed").verdict, "fixed");
		assert.equal(verdict("C1:held").verdict, "held");
		assert.equal(verdict("C1:held").pulls[0]?.builtOn, 1, "someone built on it");
		assert.equal(verdict("C1:recent").verdict, "merged", "too soon to say");
		assert.equal(verdict("C1:open").verdict, "open");
		assert.equal(verdict("C1:closed").verdict, "closed");
		assert.equal(verdict("C1:nothing").verdict, "none");
		assert.equal(history.search({ text: "cache", kind: "pull", limit: 5 }).length, 2, "the change and its revert");
	});

	it("doesn't count a revert or a fix that was never merged", async () => {
		const { host, history, crawler, opened, clock } = await setup();
		const done = host.pull(SLUG, { title: "Add the cache", head: "cache", author: "scout" });
		host.merge(SLUG, done);
		host.times(SLUG, done, { updatedAt: new Date(clock.time - 20 * DAY).toISOString(), mergedAt: new Date(clock.time - 20 * DAY).toISOString() });
		host.pull(SLUG, { title: "Revert it", head: "revert", body: `Reverts #${done}`, author: "ann" });
		opened.set(`${SLUG}#${done}`, "C1:cache");
		await crawler.runOnce();
		assert.equal(history.outcome("C1:cache", clock.time).verdict, "held", "an open pull request that says it reverts hasn't");
	});

	it("reads every page of a busy pull request's comments", async () => {
		const { host, history, crawler } = await setup();
		const pr = host.pull(SLUG, { title: "A busy one", head: "busy", author: "ann" });
		for (let i = 1; i <= 120; i++) host.comment(SLUG, pr, "bo", `remark number ${i} on the busy one`, false);
		await crawler.runOnce();
		assert.equal(history.stats().find((s) => s.source === "forge")?.documents, 121);
		assert.equal(history.search({ text: "remark number 120", kind: "comment" }).length, 1, "the newest, past the first two pages");
	});

	it("keeps an item whose comments have gone, and reads the rest", async () => {
		const { host, history, crawler } = await setup();
		host.issue(SLUG, { title: "Gone but kept", author: "ann" });
		host.issue(SLUG, { title: "Fine", author: "ann" });
		host.fail("GET", /\/issues\/1\/comments/, 404, 5);
		const [status] = await crawler.runOnce();
		assert.equal(status?.error, undefined);
		assert.equal(history.search({ text: "fine" }).length, 1);
		assert.equal(history.search({ text: "gone" }).length, 1);
	});

	it("starts nearer when a repository has more changes than one pass can read", async () => {
		const { forge, history, clock } = await setup();
		const asked: number[] = [];
		const wrapped = { ...forge, me: async () => "scout", remarks: async () => [], changed: async (_slug: string, since: number) => {
			asked.push(since);
			if (asked.length < 3) throw new TooManyChanges("too many");
			return [];
		} } as unknown as typeof forge;
		const source = forgeSource({ forge: wrapped, repos: () => [SLUG], threadOf: () => undefined, now: () => clock.time });
		const crawler = new Crawler({ history, sources: [source], now: () => clock.time, log: () => {} });
		const [status] = await crawler.runOnce();
		assert.equal(status?.error, undefined);
		assert.ok(asked[2]! > asked[1]! && asked[1]! > asked[0]!, "each try was nearer than the last");
	});

	it("keeps going with the other repositories when one can't be read", async () => {
		const { host, history, source, clock } = await setup();
		host.issue(SLUG, { title: "Readable", author: "ann" });
		const crawler = new Crawler({ history, sources: [{ ...source, scopes: () => ["acme/gone", SLUG] }], now: () => clock.time, log: () => {} });
		const [status] = await crawler.runOnce();
		assert.match(status?.error ?? "", /acme\/gone: Forgejo answered 404/);
		assert.equal(history.search({ text: "readable" }).length, 1);
	});
});

describe("one person under two names", () => {
	it("joins a code host login to the Slack user, whichever was seen first", () => {
		const history = new History(":memory:");
		history.put({ id: "slack:message:C1:1:1", source: "slack", kind: "message", thread: "C1:1", conversationId: 1, channel: "dev", author: "U1", authorName: "Mary Jones", text: "the cache is stale" });
		history.put({ id: itemId(SLUG, 5), source: "forge", kind: "pull", repo: SLUG, author: "forge:mjones", authorName: "mjones", title: "Expire the cache", text: "Adds a TTL." });
		assert.equal(history.search({ text: "cache", person: "U1" }).length, 1, "before the join: Slack only");
		assert.deepEqual(history.people("mjones").map((p) => p.id), ["forge:mjones"]);

		history.alias("forge:mjones", "U1");
		assert.equal(history.search({ text: "cache", person: "U1" }).length, 2, "after it: both");
		assert.equal(history.search({ text: "cache", person: "forge:mjones" }).length, 2, "the login finds the same");
		assert.deepEqual(history.people("mjones").map((p) => p.id), ["U1"], "one Mary, found by her login");
		assert.deepEqual(history.everyone().map((p) => p.id), ["U1"]);
	});

	it("is told by the lookup that decides who may ask for work", async () => {
		const history = new History(":memory:");
		history.put({ id: "slack:message:C1:1:1", source: "slack", kind: "message", thread: "C1:1", channel: "dev", author: "U0MARY001", authorName: "Mary Jones", text: "hello" });
		history.put({ id: "slack:message:C1:2:2", source: "slack", kind: "message", thread: "C1:2", channel: "dev", author: "U0BO000001", authorName: "Bo", text: "hello" });
		const linked = await linkLogins(history, async (user) => (user === "U0MARY001" ? "mjones" : undefined));
		assert.equal(linked, 1);
		assert.deepEqual(history.people("mjones").map((p) => p.id), ["U0MARY001"]);
		assert.equal(threadRef("C1:1"), "thread:C1:1");
	});
});
