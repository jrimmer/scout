import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allows, describeInitiative, parseInitiative } from "../src/initiative.ts";

describe("initiative", () => {
	it("is a dial: each level allows what the ones below it do", () => {
		assert.equal(parseInitiative(undefined), "team", "team unless set");
		assert.equal(parseInitiative(" Own "), "own");
		assert.throws(() => parseInitiative("proactive"), /SCOUT_INITIATIVE must be asked, own or team/);
		assert.deepEqual([allows("asked", "own"), allows("asked", "team")], [false, false]);
		assert.deepEqual([allows("own", "own"), allows("own", "team")], [true, false]);
		assert.deepEqual([allows("team", "own"), allows("team", "team")], [true, true]);
	});

	it("says plainly what each level means and how to change it", () => {
		assert.match(describeInitiative("asked"), /^Initiative: asked\. I do what people ask me to .*nothing on my own\. .*SCOUT_INITIATIVE/);
		assert.match(describeInitiative("own"), /look after my own work.*I leave the team's work alone/);
		assert.match(describeInitiative("team"), /investigating alerts, reminding reviewers/);
	});
});
