import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Ask, forgeFor, Inbox } from "../src/forge.ts";

const T0 = Date.parse("2026-10-20T12:00:00Z");
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();

/** A code host with Scout's account, its notifications, issues, comments and reviews; records what Scout did. */
function fakeHost(kind: "forgejo" | "github") {
	const state = {
		notices: [] as { id: number; repo: string; type: string; number: number }[],
		issues: new Map<string, Record<string, unknown>>(),
		comments: new Map<string, Record<string, unknown>[]>(),
		reviews: new Map<string, Record<string, unknown>[]>(),
		heads: new Map<string, Record<string, unknown>>(),
		read: [] as string[],
		posted: [] as string[],
		auth: new Set<string>(),
		privateRepos: new Set<string>(["o/r"]),
		/** Comments on lines, by pull request, with the review each belongs to. */
		lines: new Map<string, Record<string, unknown>[]>(),
		reactions: [] as string[],
		publicRepos: new Set<string>(),
	};
	const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const path = url.pathname.replace(/^\/api(\/v1)?/, "");
		const method = init?.method ?? "GET";
		state.auth.add(String((init?.headers as Record<string, string>)?.authorization).split(" ")[0]!);
		if (path === "/user") return Response.json({ login: "scout" });
		const repo = /^\/repos\/([^/]+\/[^/]+)$/.exec(path);
		if (repo) return state.publicRepos.has(repo[1]!) ? Response.json({ private: false }) : state.privateRepos.has(repo[1]!) ? Response.json({ private: true }) : new Response("no", { status: 500 });
		if (path === "/notifications" && method === "GET") {
			return Response.json(
				state.notices.map((n) => ({
					id: n.id,
					repository: { full_name: n.repo },
					subject: { type: n.type, url: `https://host/api/v1/repos/${n.repo}/${n.type === "Issue" ? "issues" : "pulls"}/${n.number}` },
				})),
			);
		}
		const read = /^\/notifications\/threads\/(\d+)$/.exec(path);
		if (read && method === "PATCH") {
			state.read.push(read[1]!);
			state.notices = state.notices.filter((n) => String(n.id) !== read[1]);
			return new Response(null, { status: 205 });
		}
		const reaction = /^\/repos\/([^/]+\/[^/]+)\/issues\/(?:comments\/(\d+)|(\d+))\/reactions$/.exec(path);
		if (reaction && method === "POST") {
			state.reactions.push(`${reaction[1]} ${reaction[2] === undefined ? `issue ${reaction[3]}` : `comment ${reaction[2]}`} ${(JSON.parse(String(init?.body)) as { content: string }).content}`);
			return Response.json({}, { status: 201 });
		}
		const perReview = /^\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/reviews\/(\d+)\/comments$/.exec(path);
		if (perReview) return Response.json(state.lines.get(`${perReview[1]}#${perReview[2]}`)?.filter((c) => c.review === Number(perReview[3])) ?? []);
		const m = /^\/repos\/([^/]+\/[^/]+)\/(issues|pulls)\/(\d+)(\/comments|\/reviews)?$/.exec(path);
		if (m) {
			const key = `${m[1]}#${m[3]}`;
			if (m[4] === "/comments" && method === "POST") {
				state.posted.push(`${key}: ${(JSON.parse(String(init?.body)) as { body: string }).body}`);
				return Response.json({ id: 1 }, { status: 201 });
			}
			if (m[4] === "/comments" && m[2] === "pulls") return Response.json(state.lines.get(key)?.map(({ review, ...c }) => ({ ...c, pull_request_review_id: review })) ?? []);
			if (m[4] === "/comments") return Response.json(state.comments.get(key) ?? []);
			if (m[4] === "/reviews") return Response.json(state.reviews.get(key) ?? []);
			if (m[2] === "pulls") return Response.json(state.heads.get(key) ?? {});
			return Response.json(state.issues.get(key));
		}
		return new Response("not found", { status: 404 });
	}) as typeof globalThis.fetch;
	const forge = forgeFor({ kind, apiUrl: kind === "github" ? "https://host" : "https://host/api/v1", token: "t" }, fetch);
	return { state, forge };
}

const issue = (number: number, extra: Record<string, unknown> = {}) => ({
	number,
	title: `Issue ${number}`,
	body: "",
	html_url: `https://host/o/r/issues/${number}`,
	user: { login: "ann" },
	state: "open",
	assignees: [],
	created_at: at(-60),
	...extra,
});

function inboxOn(host: ReturnType<typeof fakeHost>, ownPulls: number[] = []) {
	const asks: Ask[] = [];
	const inbox = new Inbox({ path: ":memory:", forge: host.forge, now: T0, handlers: { ownPull: (i) => i.pull && ownPulls.includes(i.number), ask: async (a) => void asks.push(a) } });
	return { inbox, asks };
}

describe("work from the code host", () => {
	it("takes @scout in a comment as a request, once, and nothing from before it was switched on", async () => {
		const host = fakeHost("forgejo");
		host.state.issues.set("o/r#12", issue(12, { body: "@scout this is old" }));
		host.state.comments.set("o/r#12", [
			{ id: 1, body: "@scout fix this (said before Scout listened)", user: { login: "ann" }, created_at: at(-5) },
			{ id: 2, body: "@scout can you fix the median?", user: { login: "ann" }, created_at: at(5), html_url: "https://host/o/r/issues/12#c2" },
			{ id: 3, body: "Looking.", user: { login: "scout" }, created_at: at(6) },
			{ id: 4, body: "Thanks bob, and cc @scouting", user: { login: "bob" }, created_at: at(7) },
		]);
		host.state.notices.push({ id: 7, repo: "o/r", type: "Issue", number: 12 });
		const { inbox, asks } = inboxOn(host);

		await inbox.poll();
		assert.equal(asks.length, 1);
		assert.equal(asks[0]!.why, "mentioned");
		assert.equal(asks[0]!.by, "ann");
		assert.deepEqual(asks[0]!.said.map((s) => s.body), ["@scout can you fix the median?"]);
		assert.deepEqual(host.state.read, ["7"], "the notification is marked read");

		host.state.notices.push({ id: 8, repo: "o/r", type: "Issue", number: 12 });
		await inbox.poll();
		assert.equal(asks.length, 1, "the same comment is never a request twice");
	});

	it("takes an issue assigned to Scout, and a new issue that mentions it", async () => {
		const host = fakeHost("forgejo");
		host.state.issues.set("o/r#3", issue(3, { title: "Add mode()", assignees: [{ login: "Scout" }] }));
		host.state.issues.set("o/r#4", issue(4, { body: "@Scout please add a README", created_at: at(1) }));
		host.state.notices.push({ id: 1, repo: "o/r", type: "Issue", number: 3 }, { id: 2, repo: "o/r", type: "Issue", number: 4 }, { id: 3, repo: "o/r", type: "Commit", number: 0 });
		const { inbox, asks } = inboxOn(host);
		await inbox.poll();
		assert.deepEqual(asks.map((a) => [a.issue.number, a.why]), [[3, "assigned"], [4, "mentioned"]]);
		assert.deepEqual(host.state.read, ["1", "2", "3"], "even notifications about other things are cleared");
	});

	it("takes what people say on Scout's own pull requests, but not a bare approval", async () => {
		const host = fakeHost("github");
		host.state.issues.set("o/r#8", issue(8, { pull_request: {}, html_url: "https://host/o/r/pull/8", user: { login: "scout" } }));
		host.state.comments.set("o/r#8", [{ id: 1, body: "Could the rounding be configurable?", user: { login: "ann" }, created_at: at(2) }]);
		host.state.reviews.set("o/r#8", [
			{ id: 10, body: "", user: { login: "bob" }, state: "APPROVED", submitted_at: at(3) },
			{ id: 11, body: "", user: { login: "cat" }, state: "CHANGES_REQUESTED", submitted_at: at(4) },
		]);
		host.state.lines.set("o/r#8", [{ id: 70, review: 11, body: "This rounds half to even; say so.", user: { login: "cat" }, created_at: at(4), path: "tally/stats.py", line: 12 }]);
		host.state.notices.push({ id: 5, repo: "o/r", type: "PullRequest", number: 8 });
		const { inbox, asks } = inboxOn(host, [8]);
		await inbox.poll();
		assert.equal(asks.length, 1, "several remarks since the last look come as one request");
		assert.equal(asks[0]!.why, "own pull request");
		assert.equal(asks[0]!.request, true);
		assert.equal(asks[0]!.by, "cat");
		assert.deepEqual(
			asks[0]!.said.map((s) => `${s.author} ${s.review ?? "comment"}${s.path === undefined ? "" : ` ${s.path}:${s.line}`} ${s.addressed ? "asks" : "context"}`),
			["ann comment context", "cat CHANGES_REQUESTED asks", "cat CHANGES_REQUESTED tally/stats.py:12 asks"],
			"a bare approval is nothing; a request for changes and its comment on a line ask; a plain comment is context",
		);
		assert.deepEqual([...host.state.auth], ["Bearer"], "GitHub's way of authenticating");
	});

	it("passes on plain comments on Scout's pull request as context, not a request, and reads Forgejo's comments on lines", async () => {
		const host = fakeHost("forgejo");
		host.state.issues.set("o/r#8", issue(8, { pull_request: {}, user: { login: "scout" } }));
		host.state.comments.set("o/r#8", [{ id: 1, body: "bob, does this match what we decided?", user: { login: "ann" }, created_at: at(2) }]);
		host.state.reviews.set("o/r#8", [{ id: 20, body: "A couple of thoughts.", user: { login: "bob" }, state: "COMMENT", submitted_at: at(3), comments_count: 1 }]);
		host.state.lines.set("o/r#8", [{ id: 71, review: 20, body: "Nit: name this mean_rounded?", user: { login: "bob" }, created_at: at(3), position: 7 }]);
		host.state.notices.push({ id: 9, repo: "o/r", type: "Pull", number: 8 });
		const { inbox, asks } = inboxOn(host, [8]);
		await inbox.poll();
		assert.equal(asks.length, 1);
		assert.equal(asks[0]!.request, false, "nothing in it is addressed to Scout");
		assert.deepEqual(asks[0]!.said.map((s) => `${s.author}${s.line === undefined ? "" : `:${s.line}`} ${s.body}`), [
			"ann bob, does this match what we decided?",
			"bob A couple of thoughts.",
			"bob:7 Nit: name this mean_rounded?",
		]);
	});

	it("ignores remarks on other people's pull requests unless they mention Scout", async () => {
		const host = fakeHost("forgejo");
		host.state.issues.set("o/r#9", issue(9, { pull_request: {} }));
		host.state.comments.set("o/r#9", [{ id: 1, body: "LGTM", user: { login: "bob" }, created_at: at(2) }]);
		host.state.notices.push({ id: 1, repo: "o/r", type: "Pull", number: 9 });
		const { inbox, asks } = inboxOn(host);
		await inbox.poll();
		assert.deepEqual(asks, []);
		assert.deepEqual([...host.state.auth], ["token"], "Forgejo's way of authenticating");
	});

	it("acknowledges with 👀 on the comment that asked, or on the issue, and nowhere it can't", async () => {
		const host = fakeHost("forgejo");
		await host.forge.acknowledge("o/r", 12, "comment:2");
		await host.forge.acknowledge("o/r", 3);
		await host.forge.acknowledge("o/r", 8, "review:11");
		assert.deepEqual(host.state.reactions, ["o/r comment 2 eyes", "o/r issue 3 eyes"]);
	});

	it("finds a pull request's own branch, but not a fork's", async () => {
		const host = fakeHost("forgejo");
		host.state.heads.set("o/r#9", { head: { ref: "add-mode", repo: { full_name: "o/r" } } });
		host.state.heads.set("o/r#10", { head: { ref: "main", repo: { full_name: "fork/r" } } });
		assert.equal(await host.forge.headBranch("o/r", 9), "add-mode");
		assert.equal(await host.forge.headBranch("o/r", 10), undefined);
	});

	it("sends the next answer back to where it was asked, once, with the thread's link", async () => {
		const host = fakeHost("forgejo");
		const { inbox } = inboxOn(host);
		inbox.threadStarted("o/r", 12, 40);
		inbox.replyTo(40, "o/r", 12);
		assert.equal(inbox.threadOf("o/r", 12), 40);
		await inbox.answered(41, "Not this one.", undefined);
		await inbox.answered(40, "Fixed in #13.", "https://slack/thread");
		await inbox.answered(40, "Something later.", "https://slack/thread");
		assert.deepEqual(host.state.posted, ["o/r#12: Fixed in #13.\n\n---\nFrom the thread: https://slack/thread"]);
	});

	it("on a public repository, or one whose visibility it can't tell, points to the thread instead of copying the answer", async () => {
		const host = fakeHost("github");
		host.state.publicRepos.add("pub/lib");
		const { inbox } = inboxOn(host);
		inbox.replyTo(50, "pub/lib", 3);
		await inbox.answered(50, "ann said in Slack the staging password rotates on Fridays. Opened https://host/pub/lib/pull/4 and https://host/pub/lib/pull/4.", "https://slack/t");
		inbox.replyTo(51, "unknown/repo", 1);
		await inbox.answered(51, "Something from the thread.", undefined);
		assert.deepEqual(host.state.posted, [
			"pub/lib#3: I've answered in the Slack thread: https://slack/t\n\nPull request: https://host/pub/lib/pull/4",
			"unknown/repo#1: I've answered in Slack.",
		]);
	});
});
