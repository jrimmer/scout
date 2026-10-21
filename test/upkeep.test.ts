import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Forge, PullStatus } from "../src/forge.ts";
import type { PullRow } from "../src/pulls.ts";
import { BranchCleanup, PullUpkeep } from "../src/upkeep.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-01T12:00:00Z");

function setUp(options: { pingDays?: number; closeDays?: number } = {}) {
	let status: PullStatus = { open: true, mergeable: true, updatedAt: T0, head: "h1", headRef: "scout/t-3", base: "b1", baseRef: "main" };
	let threadActivity: number | undefined;
	const events: string[] = [];
	const forge = { pullStatus: async () => status } as unknown as Forge;
	const upkeep = new PullUpkeep({
		path: ":memory:",
		forge,
		pingAfterMs: (options.pingDays ?? 14) * DAY,
		closeAfterMs: (options.closeDays ?? 7) * DAY,
		handlers: {
			conflict: async (_p, s, attempt) => void events.push(`conflict ${s.head}:${s.base} try ${attempt}`),
			conflictStuck: async (_p, s) => void events.push(`stuck ${s.head}:${s.base}`),
			nudge: async (_p, quiet, close) => void events.push(`nudge after ${Math.round(quiet / DAY)}d, closing in ${Math.round(close / DAY)}d`),
			close: async (_p, quiet) => void events.push(`close after ${Math.round(quiet / DAY)}d`),
			threadActivity: () => threadActivity,
		},
	});
	const pull: PullRow = { url: "u", number: 7, slug: "o/r", kind: "work", conversationId: 3, title: "Add mode", openedAt: T0, state: "open" };
	return {
		events,
		poll: (at: number) => upkeep.poll([pull], at),
		set: (change: Partial<PullStatus>) => (status = { ...status, ...change }),
		activity: (at: number) => (threadActivity = at),
	};
}

describe("looking after Scout's pull requests", () => {
	it("asks its thread to bring a conflicting pull request up to date, twice at most, then asks a person, once", async () => {
		const u = setUp({ pingDays: 0 });
		await u.poll(T0);
		u.set({ mergeable: false, base: "b2" });
		await u.poll(T0 + 1000);
		await u.poll(T0 + 2000);
		u.set({ head: "h2" }); // Scout pushed, but it still conflicts
		await u.poll(T0 + 3000);
		u.set({ head: "h3" });
		await u.poll(T0 + 4000);
		u.set({ head: "h4" });
		await u.poll(T0 + 5000);
		assert.deepEqual(u.events, ["conflict h1:b2 try 1", "conflict h2:b2 try 2", "stuck h3:b2"]);

		// Merging cleanly again ends it; the next conflict gets its own tries.
		u.set({ mergeable: true, head: "h5" });
		await u.poll(T0 + 6000);
		u.set({ mergeable: false, base: "b3" });
		await u.poll(T0 + 7000);
		assert.equal(u.events.at(-1), "conflict h5:b3 try 1");
		u.set({ mergeable: undefined, base: "b4" });
		await u.poll(T0 + 8000);
		assert.equal(u.events.length, 4, "while the code host is still working it out, nothing");
	});

	it("nudges after two quiet weeks, closes a week later, and starts over on any activity", async () => {
		const u = setUp();
		await u.poll(T0 + 13 * DAY);
		assert.deepEqual(u.events, []);
		await u.poll(T0 + 14 * DAY);
		u.set({ updatedAt: T0 + 14 * DAY + 1000 }); // Scout's own comment
		await u.poll(T0 + 18 * DAY);
		await u.poll(T0 + 21 * DAY);
		assert.deepEqual(u.events, ["nudge after 14d, closing in 7d", "close after 21d"]);

		const v = setUp();
		await v.poll(T0 + 14 * DAY);
		v.activity(T0 + 16 * DAY); // someone answered in Slack
		await v.poll(T0 + 16 * DAY + 1000);
		await v.poll(T0 + 21 * DAY + 1000);
		assert.deepEqual(v.events, ["nudge after 14d, closing in 7d"], "an answer means it's wanted: no close");
		await v.poll(T0 + 30 * DAY);
		assert.deepEqual(v.events.at(-1), "nudge after 14d, closing in 7d", "two quiet weeks after the answer, it asks again");
	});

	it("leaves quiet pull requests alone when it's switched off, and ignores closed ones", async () => {
		const off = setUp({ pingDays: 0 });
		await off.poll(T0 + 100 * DAY);
		assert.deepEqual(off.events, []);
		const closed = setUp();
		closed.set({ open: false, mergeable: false });
		await closed.poll(T0 + 100 * DAY);
		assert.deepEqual(closed.events, []);
	});

	it("keeps a closed pull request's branch until it can no longer be reopened", () => {
		const branches = new BranchCleanup(":memory:");
		const pull = { url: "u", slug: "o/r", number: 7, conversationId: 3 };
		branches.later(pull, T0 + 30 * DAY);
		assert.deepEqual(branches.due(T0 + 29 * DAY), []);
		assert.deepEqual(branches.due(T0 + 30 * DAY), [pull]);
		branches.done("u");
		assert.deepEqual(branches.due(T0 + 99 * DAY), []);
		branches.close();
	});
});
