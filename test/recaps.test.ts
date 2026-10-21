import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { asksSomething, Recaps } from "../src/recaps.ts";
import type { ThreadRow } from "../src/threads.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse("2026-10-20T12:00:00Z");

describe("following up on stalled threads", () => {
	it("knows an answer that waits on people from one that's done", () => {
		assert.equal(asksSomething("I can do either.\n\nWhich do you want, Ann?"), true);
		assert.equal(asksSomething("Should I go ahead?**"), true);
		assert.equal(asksSomething("Is it A? I think so, so I did A.\n\nOpened #12."), false, "only the last line counts");
		assert.equal(asksSomething("Done: https://host/o/r/pulls/12?tab=files"), false, "a ? in a link isn't a question");
		assert.equal(asksSomething("Fixed it."), false);
	});

	it("follows up once on a thread waiting on people, not one that has a pull request, and lets go when someone speaks", async () => {
		const recaps = new Recaps(":memory:");
		const threads = new Map<number, Pick<ThreadRow, "lastSpeaker">>([
			[1, { lastSpeaker: "scout" }],
			[2, { lastSpeaker: "scout" }],
			[3, { lastSpeaker: "scout" }],
		]);
		const threadOf = (id: number) => threads.get(id) as ThreadRow | undefined;
		const openPull = (id: number) => id === 2;
		recaps.answered(1, "Should I use pnpm or npm?", T0);
		recaps.answered(2, "PR is up. Want me to add tests too?", T0);
		recaps.answered(3, "Done, merged.", T0);
		assert.deepEqual(recaps.due(threadOf, openPull, 3 * DAY, T0 + 2 * DAY), [], "not yet");
		assert.deepEqual(recaps.due(threadOf, openPull, 3 * DAY, T0 + 3 * DAY), [1], "2 has its pull request's reminders; 3 isn't waiting");

		recaps.recapped(1, T0 + 3 * DAY);
		recaps.answered(1, "Recap: … Ann, pnpm or npm?", T0 + 3 * DAY);
		assert.deepEqual(recaps.due(threadOf, openPull, 3 * DAY, T0 + 9 * DAY), [], "one follow-up per stall, even though the recap asks too");
		assert.deepEqual(recaps.waiting(threadOf), [{ conversationId: 1, since: T0 }], "the weekly summary lists it");

		threads.set(1, { lastSpeaker: "UANN" });
		assert.deepEqual(recaps.waiting(threadOf), [], "someone answered: let go");
		recaps.answered(1, "pnpm it is. Anything else?", T0 + 10 * DAY);
		threads.set(1, { lastSpeaker: "scout" });
		assert.deepEqual(recaps.due(threadOf, openPull, 3 * DAY, T0 + 13 * DAY), [1], "a new stall gets its own follow-up");
		assert.deepEqual(recaps.due(threadOf, openPull, 0, T0 + 99 * DAY), [], "0 days: off");
		recaps.close();
	});
});
