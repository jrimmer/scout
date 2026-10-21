import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Forge, OpenPull } from "../src/forge.ts";
import { ownersOf, parseCodeOwners, recentOwners } from "../src/owners.ts";
import { ReviewNudges } from "../src/upkeep.ts";

const DAY = 24 * 60 * 60 * 1000;

describe("who should review", () => {
	const rules = parseCodeOwners(`
# Everything, unless a later rule says otherwise
*               @lead
*.md            @writer   # docs people
/docs/          @writer @lead
src/api/        @platform/api
**/tests/       @qa
Makefile        build@example.com
`);

	it("reads CODEOWNERS like the code hosts do: the last matching rule wins, teams apart from people", () => {
		assert.deepEqual(ownersOf(rules, ["src/app.ts"]), { users: ["lead"], teams: [] });
		assert.deepEqual(ownersOf(rules, ["README.md", "src/deep/notes.md"]), { users: ["writer"], teams: [] });
		assert.deepEqual(ownersOf(rules, ["docs/guide/setup.txt"]), { users: ["writer", "lead"], teams: [] });
		assert.deepEqual(ownersOf(rules, ["src/api/routes.ts"]), { users: [], teams: ["platform/api"] });
		assert.deepEqual(ownersOf(rules, ["src/api/tests/routes.test.ts", "lib/tests/x.ts"]), { users: ["qa"], teams: [] });
		assert.deepEqual(ownersOf(rules, ["Makefile"]), { users: [], teams: [] }, "an email owner isn't someone the code host can ask");
		assert.deepEqual(ownersOf(rules, ["other/docs/x.txt"]), { users: ["lead"], teams: [] }, "/docs/ is anchored at the root");
	});

	it("falls back to who changed the files most, leaving out Scout and duplicates", () => {
		assert.deepEqual(recentOwners(["ann", "bob", "ann", undefined, "scout", "cat", "ann", "bob"], ["Scout"]), ["ann", "bob"]);
		assert.deepEqual(recentOwners([undefined], []), []);
	});
});

describe("review reminders", () => {
	const pull = (number: number, extra: Partial<OpenPull>): OpenPull => ({
		number,
		title: `Change ${number}`,
		url: `https://host/o/r/pulls/${number}`,
		author: "ann",
		draft: false,
		createdAt: 0,
		reviewers: ["bob"],
		teams: [],
		...extra,
	});

	it("lists pull requests waiting on someone's review for three days, once a day per channel", async () => {
		const now = 10 * DAY;
		const pulls: Record<string, OpenPull[]> = {
			"o/web": [
				pull(1, { createdAt: now - 4 * DAY }),
				pull(2, { createdAt: now - 1 * DAY }),
				pull(3, { createdAt: now - 9 * DAY, reviewers: [] }),
				pull(4, { createdAt: now - 9 * DAY, draft: true }),
				pull(5, { createdAt: now - 5 * DAY, reviewers: [], teams: ["platform/api"] }),
			],
			"o/api": [pull(6, { createdAt: now - 2 * DAY })],
		};
		const forge = { openPulls: async (slug: string) => pulls[slug] ?? [] } as unknown as Forge;
		const nudges = new ReviewNudges({ path: ":memory:", forge, waitMs: 3 * DAY });
		const repos = [
			{ slug: "o/web", channel: "web" },
			{ slug: "o/api", channel: "api" },
		];
		const first = await nudges.waiting(repos, "2026-10-21", now);
		assert.deepEqual([...first.keys()], ["web"], "nothing waits long enough in api");
		assert.deepEqual(first.get("web")!.map((p) => p.number), [1, 5], "not too new, not without reviewers, not a draft");
		assert.equal((await nudges.waiting(repos, "2026-10-21", now)).size, 0, "once a day");
		pulls["o/api"]![0]!.createdAt = now - 5 * DAY;
		assert.deepEqual([...(await nudges.waiting(repos, "2026-10-21", now)).keys()], ["api"], "a quiet channel can still be reminded later that day");
		assert.equal((await new ReviewNudges({ path: ":memory:", forge, waitMs: 0 }).waiting(repos, "2026-10-21", now)).size, 0, "0 days: off");
		nudges.close();
	});
});
