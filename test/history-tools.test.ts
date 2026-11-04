import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { History, threadRef } from "../src/history.ts";
import { historyExtension } from "../src/history-tools.ts";
import { itemId } from "../src/source-forge.ts";
import { Threads } from "../src/threads.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 4, 12);
const MARY = "U0MARY001";
const BO = "U0BO000001";

function setup(options: { ask?: "public" | "admin"; admins?: string[]; readable?: string[] } = {}) {
	const history = new History(":memory:");
	const threads = new Threads(":memory:");
	// Conversation 1 is a thread Bo asked in; 2 is one started by Scout, with no one asking.
	threads.insert({ key: "C1:100.1", conversationId: 1, channel: "C1", threadTs: "100.1", startedBy: BO }, NOW);
	threads.insert({ key: "C1:200.1", conversationId: 2, channel: "C1", threadTs: "200.1", startedBy: "scout" }, NOW);
	threads.asked("C1:200.1", "scout");
	const say = (thread: string, id: number, ts: string, user: string, name: string, text: string, ago = 1) =>
		history.put({ id: `slack:message:${thread}:${ts}`, source: "slack", kind: "message", thread, conversationId: id, channel: "deploys", author: user, authorName: name, at: NOW - ago * DAY, text });
	say("C1:50.1", 50, "50.1", MARY, "Mary Jones", "The staging build is slow; I profile it with --profile before touching the cache.", 3);
	say("C1:50.1", 50, "50.2", "scout", "Scout", "The type check takes 190s of the 212s.", 3);
	say("C1:60.1", 60, "60.1", MARY, "Mary Jones", "Deploys fail on the cache warmup; I bisect the config first.", 2);
	say("C1:70.1", 70, "70.1", BO, "Bo Smith", "The cache layout confuses me.", 1);
	history.alias("forge:mjones", MARY);
	history.put({ id: itemId("acme/app", 9), source: "forge", kind: "pull", repo: "acme/app", author: "forge:mjones", authorName: "mjones", at: NOW - 2 * DAY, title: "Warm the cache on boot", text: "Warms the cache.", meta: { state: "merged", mergedAt: NOW - DAY } });
	history.put({ id: "forge:remark:acme/app#9:review:1", source: "forge", kind: "review", repo: "acme/app", author: "forge:bsmith", authorName: "bsmith", at: NOW - 2 * DAY, parent: itemId("acme/app", 9), text: "Add a timeout to the warmup.", meta: { review: "changes" } });
	history.put({ id: itemId("acme/secret", 3), source: "forge", kind: "pull", repo: "acme/secret", author: "forge:ann", authorName: "ann", at: NOW - DAY, title: "Rotate the cache keys", text: "Rotates the cache keys.", meta: { state: "open" } });
	history.link({ from: threadRef("C1:50.1"), to: itemId("acme/app", 9), rel: "opened", source: "forge" });

	const repos = [
		{ name: "app", slug: "acme/app", channels: ["deploys"] },
		{ name: "secret", slug: "acme/secret", channels: ["secret-ops"] },
	];
	const extension = historyExtension({
		history,
		threads,
		link: async (t) => `https://slack.test/${t.key}`,
		readable: async () => repos.filter((r) => (options.readable ?? ["app"]).includes(r.name)),
		repos: () => repos,
		askerOf: (id) => threads.byConversation(id)?.lastAsker,
		ask: options.ask ?? "public",
		isAdmin: async (user) => (options.admins ?? []).includes(user),
		now: () => NOW,
	});
	const [search, read, activity] = extension.tools!;
	const run = async (tool: typeof search, args: object, conversation = 1): Promise<string> => {
		const result = await tool!.execute(args as never, { conversationId: conversation } as never, context);
		return (result?.output ?? []).map((o) => (o as { text: string }).text).join("\n");
	};
	return { history, search: (a: object, c?: number) => run(search, a, c), read: (a: object, c?: number) => run(read, a, c), activity: (a: object, c?: number) => run(activity, a, c) };
}

describe("search_history", () => {
	it("finds what a person said and wrote, under both names, and gives an id to read it by", async () => {
		const t = setup();
		const found = await t.search({ query: "cache", person: "Mary" });
		assert.match(found, /Mary Jones in #deploys, 2026-11-02/);
		assert.match(found, /mjones in acme\/app, 2026-11-02/, "her pull request is hers too");
		assert.match(found, /id: forge:item:acme\/app#9/);
		assert.doesNotMatch(found, /Bo Smith/);
	});

	it("narrows by repository to its pull requests and the threads in its channels", async () => {
		const t = setup();
		const found = await t.search({ query: "cache", repo: "app" });
		assert.match(found, /Warm the cache|Warms the cache|acme\/app/);
		assert.match(found, /#deploys/);
		assert.doesNotMatch(found, /Rotate the cache keys/);
	});

	it("leaves out a repository the thread can't read, and says so if asked for it", async () => {
		const t = setup();
		assert.doesNotMatch(await t.search({ query: "rotates cache keys" }), /acme\/secret/);
		assert.match(await t.search({ query: "cache", repo: "secret" }), /I can't read secret from this thread/);
		const may = setup({ readable: ["app", "secret"] });
		assert.match(await may.search({ query: "rotates cache keys" }), /acme\/secret/);
	});

	it("says when it doesn't know a person, or knows two", async () => {
		const t = setup();
		assert.match(await t.search({ query: "cache", person: "Zed" }), /I don't know anyone called "Zed"/);
		assert.match(await t.search({ query: "cache", person: "o" }), /More than one person matches "o": Bo Smith, Mary Jones/);
	});

	it("keeps the asking thread out of its own results", async () => {
		const t = setup();
		t.history.put({ id: "slack:message:C1:100.1:100.1", source: "slack", kind: "message", thread: "C1:100.1", conversationId: 1, channel: "deploys", author: BO, authorName: "Bo Smith", text: "zebra stripes confuse the linter" });
		assert.match(await t.search({ query: "zebra stripes" }), /Nothing earlier matches/);
		assert.match(await t.search({ query: "zebra stripes" }, 2), /zebra/, "another thread finds it");
	});
});

describe("read_history", () => {
	it("reads a thread whole, as the people in it spoke", async () => {
		const t = setup();
		const text = await t.read({ id: "C1:50.1" });
		assert.match(text, /Mary Jones: The staging build is slow/);
		assert.match(text, /Scout: The type check takes 190s/);
		assert.match(text, /Mary Jones: .*\nScout: /);
	});

	it("reads a pull request with its reviews", async () => {
		const text = await setup().read({ id: "forge:item:acme/app#9" });
		assert.match(text, /mjones: Warm the cache on boot/);
		assert.match(text, /bsmith: Add a timeout to the warmup\./);
	});

	it("reads a person's recent threads, and says how many it read and of how many", async () => {
		const text = await setup().read({ person: "Mary Jones", limit: 2 });
		assert.match(text, /Read the 2 most recent of 3 threads Mary Jones took part in\./);
		assert.match(text, /Deploys fail on the cache warmup/);
		assert.doesNotMatch(text, /Bo Smith/);
	});

	it("keeps the start and the end when a thread is longer than the budget", () => {
		const history = new History(":memory:");
		for (let i = 1; i <= 40; i++) history.put({ id: `slack:message:T:${i}`, source: "slack", kind: "message", thread: "T", conversationId: 5, channel: "x", author: MARY, authorName: "Mary", at: i, text: `message number ${i} ${"words ".repeat(40)}` });
		const t = history.read("T", { budget: 2000 })!;
		assert.ok(t.omitted > 0 && t.omitted < 40);
		assert.match(t.entries[0]!.text, /message number 1 /);
		assert.match(t.entries.at(-1)!.text, /message number 40 /);
		assert.ok(t.entries.reduce((n, e) => n + e.text.length, 0) <= 2000 + 1200);
	});

	it("won't read a pull request in a repository the thread can't read", async () => {
		assert.match(await setup().read({ id: "forge:item:acme/secret#3" }), /I can't read acme\/secret from this thread/);
	});
});

describe("repo_activity", () => {
	it("counts what happened, without judging", async () => {
		const text = await setup().activity({ repo: "app", since_days: 30 });
		assert.match(text, /app, 2026-10-05 to 2026-11-04:/);
		assert.match(text, /3 threads in #deploys, 3 people/);
		assert.match(text, /1 pull requests opened \(0 by Scout\): 1 merged, 0 closed without merging, 0 open/);
		assert.match(text, /0 with no request for changes, 1 after at least one; 1 reviews asked for changes in all/);
		assert.match(text, /what became of Scout's pull requests: 1 merged/);
	});
});

describe("SCOUT_HISTORY_ASK=admin", () => {
	it("keeps people and reports to admins, and plain search open to everyone", async () => {
		const t = setup({ ask: "admin", admins: [MARY] });
		const asked = await t.search({ query: "cache" }); // Bo's thread: not an admin
		assert.match(asked, /Mary Jones in #deploys/, "finding earlier threads stays open");
		for (const refused of [await t.search({ query: "cache", person: "Mary" }), await t.read({ id: "C1:50.1" }), await t.activity({ repo: "app" })]) {
			assert.match(refused, /are for admins here/);
		}
	});

	it("lets an admin ask, and refuses a thread nobody asked in", async () => {
		const admin = setup({ ask: "admin", admins: [BO] });
		assert.match(await admin.read({ id: "C1:50.1" }), /Mary Jones: The staging build is slow/);
		assert.match(await admin.read({ id: "C1:50.1" }, 2), /are for admins here/, "Scout's own thread has no one to be an admin");
	});

	it("is public by default", async () => {
		assert.match(await setup().activity({ repo: "app" }), /threads in #deploys/);
	});
});
