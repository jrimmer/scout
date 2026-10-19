import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Pulls, weekOf } from "../src/pulls.ts";

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
		pulls.opened({ url: "u1", number: 1, slug: "o/r", kind: "work", conversationId: 1, title: "A" }, now - DAY);
		pulls.opened({ url: "u1", number: 1, slug: "o/r", kind: "work", conversationId: 1, title: "A again" }, now);
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

	it("names weeks by their Monday", () => {
		assert.equal(weekOf(new Date(2026, 9, 19)), "2026-10-19");
		assert.equal(weekOf(new Date(2026, 9, 25)), "2026-10-19");
		assert.equal(weekOf(new Date(2026, 9, 26)), "2026-10-26");
	});
});
