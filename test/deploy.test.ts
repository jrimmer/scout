import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ciVerdict, piMove, slugOn } from "../src/deploy.ts";

describe("deploying", () => {
	it("deploys a commit only once everything that reports CI on it has passed", () => {
		const status = (...states: [string, string][]) => ({ total_count: states.length, statuses: states.map(([context, status]) => ({ context, status })) });
		assert.deepEqual(ciVerdict(status(["ci / test", "success"], ["ci / docker", "success"]), []), { ok: true, say: "CI passed on it (ci / test, ci / docker)" });
		assert.deepEqual(ciVerdict(status(["ci / test", "success"], ["ci / docker", "failure"]), []), { ok: false, say: "CI failed on it: ci / docker" });
		assert.deepEqual(ciVerdict(status(["ci / test", "pending"]), []), { ok: false, say: "CI is still running on it (ci / test); try again once it's done" });
		assert.equal(ciVerdict(status(["ci / test", "error"]), []).ok, false);
		assert.deepEqual(ciVerdict({ total_count: 0, statuses: [] }, []), { ok: false, say: "nothing has reported CI on it yet" }, "no CI is no proof");
		// GitHub's commit statuses use `state`, and its own Actions report as check runs.
		assert.equal(ciVerdict({ statuses: [{ context: "deploy/preview", state: "success" }] }, []).ok, true);
		const run = (name: string, status: string, conclusion: string | null) => ({ name, status, conclusion });
		assert.deepEqual(ciVerdict({ total_count: 0, statuses: null }, [run("test", "completed", "success"), run("lint", "completed", "skipped")]), { ok: true, say: "CI passed on it (test, lint)" });
		assert.equal(ciVerdict({}, [run("test", "in_progress", null)]).ok, false);
		assert.equal(ciVerdict({}, [run("test", "completed", "cancelled")]).say, "CI failed on it: test");
	});

	it("knows when a change moves Pi Durable, which may convert pi.sqlite for good", () => {
		const pkg = (version?: string) => JSON.stringify({ dependencies: { "@slack/bolt": "^5.1.0", ...(version === undefined ? {} : { "@earendil-works/pi-durable": version }) } });
		assert.equal(piMove(pkg("1.4.0"), pkg("1.4.0")), undefined);
		assert.equal(piMove(pkg("1.4.0"), pkg("1.5.0")), "1.4.0 to 1.5.0");
		assert.equal(piMove(pkg(), pkg("1.4.0")), "nothing to 1.4.0");
	});

	it("finds Scout's own repository on the code host from the checkout's remote", () => {
		assert.equal(slugOn("ssh://git@git.lacy.casa/jrimmer/scout.git", "https://git.lacy.casa/api/v1"), "jrimmer/scout");
		assert.equal(slugOn("ssh://git@git.example.com:2222/team/scout.git", "https://git.example.com/api/v1"), "team/scout");
		assert.equal(slugOn("git@github.com:team/scout.git", "https://api.github.com"), "team/scout");
		assert.equal(slugOn("https://github.com/team/scout", "https://api.github.com"), "team/scout");
		assert.equal(slugOn("https://github.com/team/scout.git", "https://git.example.com/api/v1"), undefined, "another code host can't answer for it");
		assert.equal(slugOn("/srv/git/scout.git", "https://git.example.com/api/v1"), undefined);
	});
});
