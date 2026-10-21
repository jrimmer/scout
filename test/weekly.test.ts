import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PullRow } from "../src/pulls.ts";
import type { ThreadRow } from "../src/threads.ts";
import { channelCanvas, channelWeeks, WeeklySummaries } from "../src/weekly.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-26T10:00:00Z");

const thread = (conversationId: number) => ({ conversationId }) as ThreadRow;
const pull = (conversationId: number, number: number, state: PullRow["state"], openedAt = NOW - 3 * DAY): PullRow => ({
	url: `https://host/o/r/pulls/${number}`,
	number,
	slug: "o/r",
	kind: "work",
	conversationId,
	title: `Change ${number}`,
	openedAt,
	state,
});

describe("each channel's week", () => {
	it("says what Scout did, what's still open and what it noted, per channel, and nothing for a quiet one", async () => {
		const channels: Record<number, string> = { 1: "web", 2: "web", 3: "api", 4: "quiet" };
		const summaries = await channelWeeks(
			{
				threads: [thread(1), thread(2), thread(3)],
				pulls: [pull(1, 10, "merged"), pull(2, 11, "open"), pull(3, 12, "closed")],
				stillOpen: [pull(2, 11, "open"), pull(4, 5, "open", NOW - 20 * DAY)],
				notes: [{ id: 7, channelName: "web", note: "Run pnpm, not npm.", createdAt: NOW - 2 * DAY }],
				waiting: [{ conversationId: 2, link: "https://slack/t2", since: NOW - 4 * DAY }],
				channelOf: async (id) => channels[id] ?? "",
				spend: (channel) => (channel === "web" ? { cost: 3.4, budget: 50 } : { cost: 0.5 }),
			},
			NOW,
		);
		assert.deepEqual([...summaries.keys()].sort(), ["api", "web"], "a channel with only an old open pull request isn't summarized");
		assert.equal(
			summaries.get("web"),
			[
				"*Last week here:* 2 threads, 1 pull request merged, 1 opened and still in review. Models cost $3.40 of $50.",
				"*Still open:*",
				"• <https://host/o/r/pulls/11|o/r#11> Change 11 (opened 3 days ago)",
				"*Waiting on someone:*",
				"• <https://slack/t2|a thread> (quiet for 4 days)",
				"*What I noted:*",
				"• [7] Run pnpm, not npm.",
				"If any of these are wrong, tell me to forget them.",
			].join("\n"),
		);
		assert.equal(summaries.get("api"), "*Last week here:* 1 thread, 1 closed without merging. Models cost $0.50.");
	});

	it("posts each channel's week once", () => {
		const sent = new WeeklySummaries(":memory:");
		assert.equal(sent.claim("2026-W43", "web"), true);
		assert.equal(sent.claim("2026-W43", "web"), false);
		assert.equal(sent.claim("2026-W43", "api"), true);
		sent.close();
	});

	it("keeps the week's numbers in the post when the channel has a canvas, and the rest in the canvas", async () => {
		const summaries = await channelWeeks(
			{
				threads: [thread(1)],
				pulls: [pull(1, 10, "merged")],
				stillOpen: [pull(1, 11, "open")],
				notes: [],
				channelOf: async () => "web",
				spend: () => ({ cost: 1 }),
				canvased: new Set(["web"]),
			},
			NOW,
		);
		assert.equal(summaries.get("web"), "*Last week here:* 1 thread, 1 pull request merged. Models cost $1.00.\nWhat's still open, who's waiting on whom, and what I noted are in this channel's canvas, kept up to date.");
		const canvas = channelCanvas({
			channel: "web",
			open: [pull(1, 11, "open")],
			waiting: [{ link: "https://slack/t2", since: NOW - 2 * DAY }],
			schedules: [{ id: 3, when: "every Monday at 9:00", task: "check for dependency updates", createdBy: "UANN", paused: false }],
			notes: [{ id: 7, channelName: "web", note: "Run pnpm, not npm.", createdAt: NOW }],
			listUrl: "https://slack/lists/L1",
			now: NOW,
		});
		assert.match(canvas, /^# Scout in #web\n_Updated /);
		assert.match(canvas, /## Open pull requests\n- \[o\/r#11 Change 11\]\(https:\/\/host\/o\/r\/pulls\/11\), open 3 days/);
		assert.match(canvas, /- \[A thread\]\(https:\/\/slack\/t2\), quiet for 2 days/);
		assert.match(canvas, /Set up by !\[\]\(@UANN\)\./);
		assert.match(canvas, /- \[7\] Run pnpm, not npm\.\n_If one of these is wrong/);
		assert.match(canvas, /\[Scout's work\]\(https:\/\/slack\/lists\/L1\)/);
	});
});
