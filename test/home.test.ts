import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { homeView } from "../src/home.ts";

const text = (view: { blocks: unknown[] }) => JSON.stringify(view.blocks);

describe("App Home", () => {
	it("shows what Scout is doing, what's waiting on you, your threads and your schedules", () => {
		const view = homeView({
			working: [{ link: "https://slack/t1", channel: "web", minutes: 4, lastStep: "`bash npm test`" }],
			queued: 2,
			threads: [
				{ link: "https://slack/t1", channel: "web", about: "@Scout fix the flaky login test", state: "working" },
				{ link: "https://slack/t2", channel: "api", about: "rename the Scout test dashboard", state: "waiting on you" },
			],
			waitingOnYou: [{ link: "https://slack/t2", channel: "api", what: "a change waiting for your approval" }],
			schedules: [{ id: 3, channel: "web", when: "every Monday at 9:00", task: "check for dependency updates", paused: false }],
		});
		assert.equal(view.type, "home");
		const shown = text(view);
		assert.match(shown, /⚙️ <https:\/\/slack\/t1\|#web>, 4 min: `bash npm test`/);
		assert.match(shown, /⏳ 2 more waiting to start/);
		assert.match(shown, /Waiting on you/);
		assert.match(shown, /👋 <https:\/\/slack\/t2\|#api>: a change waiting for your approval/);
		assert.match(shown, /⏰ #3 in #web: every Monday at 9:00, check for dependency updates/);
	});

	it("says plainly when there's nothing", () => {
		const shown = text(homeView({ working: [], queued: 0, threads: [], waitingOnYou: [], schedules: [] }));
		assert.match(shown, /Nothing on my plate/);
		assert.match(shown, /None yet/);
		assert.doesNotMatch(shown, /Waiting on you|Schedules you set up/);
	});
});
