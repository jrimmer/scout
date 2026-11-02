import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { feedbackOn, listAll, Pulls, weekOf } from "../src/pulls.ts";

const DAY = 24 * 60 * 60 * 1000;
const HOST = { kind: "forgejo", apiUrl: "http://forge/api/v1", token: "t" } as const;

function codeHost(states: Record<number, { state: string; merged?: boolean }>) {
	const asked: string[] = [];
	const fetch = async (url: string | URL | Request) => {
		asked.push(String(url));
		const number = Number(String(url).split("/").pop());
		return new Response(JSON.stringify(states[number] ?? { state: "open" }), { status: 200 });
	};
	return { asked, fetch: fetch as typeof globalThis.fetch };
}

describe("pulls", () => {
	it("follows pull requests until they are decided", async () => {
		const pulls = new Pulls(":memory:");
		const now = Date.parse("2026-10-19T10:00:00Z");
		assert.equal(pulls.opened({ url: "u1", number: 1, slug: "o/r", kind: "work", conversationId: 1, title: "A" }, now - DAY), true);
		assert.equal(pulls.opened({ url: "u1", number: 1, slug: "o/r", kind: "work", conversationId: 1, title: "A again" }, now), false, "an update isn't new");
		pulls.opened({ url: "u2", number: 2, slug: "o/r", kind: "work", conversationId: 2, title: "B" }, now - DAY);

		const host = codeHost({ 1: { state: "closed", merged: true } });
		const decided = await pulls.refresh(HOST, host.fetch, now);
		assert.deepEqual(decided.map((p) => [p.url, p.state]), [["u1", "merged"]]);
		assert.deepEqual(host.asked.sort(), ["http://forge/api/v1/repos/o/r/pulls/1", "http://forge/api/v1/repos/o/r/pulls/2"]);
		assert.equal(pulls.get("u1")?.title, "A", "an update keeps the first record");

		// Recently checked: not asked again; decided: never asked again.
		await pulls.refresh(HOST, host.fetch, now + 60_000);
		assert.equal(host.asked.length, 2);
		await pulls.refresh(HOST, host.fetch, now + DAY);
		assert.deepEqual(host.asked.slice(2), ["http://forge/api/v1/repos/o/r/pulls/2"]);
		pulls.close();
	});

	it("reports the week's merge rate once, against the week before", async () => {
		const pulls = new Pulls(":memory:");
		const now = Date.parse("2026-10-19T10:00:00Z");
		const states: Record<number, { state: string; merged?: boolean }> = {};
		const open = (n: number, kind: "work" | "profile", at: number) =>
			pulls.opened({ url: `u${n}`, number: n, slug: "o/r", kind, conversationId: n, title: `T${n}` }, at);

		// The week before: 1 of 2 merged.
		open(1, "work", now - 12 * DAY);
		open(2, "work", now - 12 * DAY);
		states[1] = { state: "closed", merged: true };
		states[2] = { state: "closed" };
		await pulls.refresh(HOST, codeHost(states).fetch, now - 10 * DAY);
		// Last week: 3 of 4 merged, one still open, and a merged profile proposal.
		for (const n of [3, 4, 5, 6, 7]) open(n, "work", now - 3 * DAY);
		open(8, "profile", now - 3 * DAY);
		Object.assign(states, {
			3: { state: "closed", merged: true },
			4: { state: "closed", merged: true },
			5: { state: "closed", merged: true },
			6: { state: "closed" },
			8: { state: "closed", merged: true },
		});
		await pulls.refresh(HOST, codeHost(states).fetch, now - DAY);

		assert.equal(
			pulls.weeklyReport("2026-10-19", now),
			"Last week I opened 5 pull requests. Of the 4 that were decided, 3 merged (75%, up from 50% the week before). " +
				"1 is still open. People merged 1 of 1 changes I proposed to how I work.",
		);
		assert.equal(pulls.weeklyReport("2026-10-19", now), undefined);
		pulls.close();
	});

	it("says what models cost each week", () => {
		const pulls = new Pulls(":memory:");
		const now = Date.parse("2026-10-19T10:00:00Z");
		const week = 7 * DAY;
		assert.match(pulls.weeklyReport("2026-10-05", now - 2 * week, 10) ?? "", /Models cost \$10\.00 so far\.$/);
		assert.match(pulls.weeklyReport("2026-10-12", now - week, 25.5) ?? "", /Models cost \$15\.50\.$/);
		assert.match(pulls.weeklyReport("2026-10-19", now, 30) ?? "", /Models cost \$4\.50 \(\$15\.50 the week before\)\.$/);
		pulls.close();
	});

	it("names weeks by their Monday", () => {
		assert.equal(weekOf(new Date(2026, 9, 19)), "2026-10-19");
		assert.equal(weekOf(new Date(2026, 9, 25)), "2026-10-19");
		assert.equal(weekOf(new Date(2026, 9, 26)), "2026-10-26");
	});
});

describe("reading a pull request's feedback", () => {
	/** A code host that pages its lists, `size` to a page, with a Link header like GitHub's and Gitea's. */
	function paged(lists: Record<string, unknown[]>, size: number) {
		const asked: string[] = [];
		const fetch = async (url: string | URL | Request) => {
			const u = new URL(String(url));
			asked.push(`${u.pathname}${u.search}`);
			const items = lists[u.pathname] ?? [];
			const page = Number(u.searchParams.get("page") ?? 1);
			const headers: Record<string, string> = {};
			if (page * size < items.length) {
				u.searchParams.set("page", String(page + 1));
				headers.link = `<${u.href}>; rel="next", <${u.href}>; rel="last"`;
			}
			return new Response(JSON.stringify(items.slice((page - 1) * size, page * size)), { status: 200, headers });
		};
		return { asked, fetch: fetch as typeof globalThis.fetch };
	}

	it("follows every page of a list, and never to another host", async () => {
		const all = Array.from({ length: 5 }, (_, i) => i);
		const { asked, fetch } = paged({ "/api/v1/things": all }, 2);
		assert.deepEqual(await listAll<number>(fetch, "http://forge/api/v1/things", {}), all);
		assert.equal(asked.length, 3);
		const elsewhere = (async () =>
			new Response("[1]", { headers: { link: '<http://evil.example/steal>; rel="next"' } })) as unknown as typeof globalThis.fetch;
		assert.deepEqual(await listAll<number>(elsewhere, "http://forge/api/v1/things", {}), [1]);
		assert.deepEqual(await listAll<number>(fetch, "http://forge/api/v1/things", {}, 2), [0, 1, 2, 3], "capped");
	});

	it("reads comments past the first page, and keeps the newest when there are too many", async () => {
		const note = (n: number, text = `comment ${n}`) => ({ user: { login: "bob" }, body: text, created_at: `2026-10-${String(10 + n).padStart(2, "0")}T00:00:00Z` });
		const old = Array.from({ length: 10 }, (_, n) => note(n, `${"old ".repeat(100)}${n}`));
		const { fetch } = paged(
			{ "/api/v1/repos/team/app/issues/3/comments": [...old, note(20, "the latest word")], "/api/v1/repos/team/app/pulls/3/reviews": [], "/api/v1/repos/team/app/pulls/3/comments": [] },
			4,
		);
		const lines = await feedbackOn(HOST, { slug: "team/app", number: 3 }, undefined, fetch);
		assert.equal(lines.at(-1), "bob: the latest word", "the newest comment, from the last page, is kept");
		assert.ok(lines.join("").length <= 3_000);
		assert.ok(lines.length < 11, "the earliest were dropped to fit");
	});
});
