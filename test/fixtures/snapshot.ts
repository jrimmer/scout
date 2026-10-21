import type { Snapshot } from "../../src/dash/collect.ts";

const now = Date.parse("2026-10-19T14:02:11");
const min = 60_000;

/** A busy afternoon, for layout tests. */
export const busy: Snapshot = {
	now,
	startedAt: now - (3 * 60 + 12) * min,
	host: "scout-1",
	model: "anthropic/claude-opus-5-5",
	alerts: [{ message: "profile pull failed: could not read from remote repository", since: now - 40 * min }],
	working: [
		{ channel: "checkout", startedAt: now - 134_000, steps: 12, lastStep: "bash npm test -- cart" },
		{ channel: "tobi_scout", startedAt: now - 20_000, steps: 2, lastStep: "search_threads flaky deploy" },
	],
	threadsToday: 17,
	threads: [
		{ channel: "checkout", startedBy: "U1", runs: 4, pulls: 1, lastActivity: now - 1 * min, working: true },
		{ channel: "tobi_scout", startedBy: "U2", runs: 1, pulls: 0, lastActivity: now - 2 * min, working: true },
		{ channel: "data-team", startedBy: "U3", runs: 2, pulls: 0, lastActivity: now - 95 * min, working: false },
	],
	pulls: {
		week: { merged: 7, closed: 2 },
		lastWeek: { merged: 3, closed: 3 },
		openNow: 4,
		latest: [
			{ title: "Fix rounding in cart totals", slug: "team/storefront", state: "open", kind: "work", openedAt: now - 30 * min },
			{ title: "Teach Scout the deploy command", slug: "team/scout-profile", state: "merged", kind: "profile", openedAt: now - 11 * 60 * min },
			{ title: "Remove dead feature flag 🚩 checkout_v2", slug: "team/storefront", state: "closed", kind: "work", openedAt: now - 30 * 60 * min },
		],
	},
	learning: {
		reflectHour: 3,
		profileRepo: true,
		last: { day: "2026-10-19", threads: 9, proposal: { title: "Teach Scout the deploy command", state: "merged" } },
		proposals: { merged: 5, closed: 1 },
		notes: [
			{ id: 12, channelName: "checkout", note: "Cart tests need REDIS_URL set; use the compose file in dev/.", createdAt: now - 3 * 24 * 60 * min },
			{ id: 15, channelName: "data-team", note: "The orders table is partitioned by day; always filter on created_on.", createdAt: now - 50 * min },
		],
	},
	schedules: [{ id: 1, channel: "storefront", when: "every Monday at 9:00", task: "check for dependency updates and open a pull request if any are due", paused: false, next: Date.parse("2026-10-26T16:00:00Z") }],
	reviews: { latest: [{ slug: "team/storefront", number: 412, sha: "a1b2c3d4e5", posted: true }, { slug: "team/api", number: 88, sha: "ffee0011", posted: false }] },
	spend: { total: 41.27, byModel: [{ model: "anthropic/claude-opus-5-5", cost: 38.9 }, { model: "anthropic/claude-haiku-5-5", cost: 2.37 }] },
	history: { working: [0, 1, 1, 2, 3, 2, 1, 0, 0, 1, 2, 2], spendPerHour: [1.2, 3.4, 2.2, 5.1, 4.4, 2.0, 0.5, 6.1] },
};
