import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CiWatcher, MAX_FIXES } from "../src/ci.ts";
import { Pulls } from "../src/pulls.ts";

describe("CI on Scout's pull requests", () => {
	it("says when it's green, asks the thread to fix red, and hands over after two tries", async () => {
		const pulls = new Pulls(":memory:");
		pulls.opened({ url: "http://forge/o/r/pulls/4", number: 4, slug: "o/r", kind: "work", conversationId: 9, title: "Add b" });
		let head = "sha1";
		let status: { state: string; total_count: number; statuses?: unknown[] } = { state: "pending", total_count: 0 };
		const events: string[] = [];
		const watcher = new CiWatcher({
			pulls,
			host: { kind: "forgejo", apiUrl: "http://forge/api/v1", token: "t" },
			fetch: (async (url: string | URL | Request) => {
				const path = new URL(String(url)).pathname;
				if (path === "/api/v1/repos/o/r/pulls/4") return Response.json({ head: { sha: head } });
				if (path === `/api/v1/repos/o/r/commits/${head}/status`) return Response.json(status);
				return new Response("no", { status: 404 });
			}) as typeof fetch,
			handlers: {
				passed: async (_pull, sha) => void events.push(`passed ${sha}`),
				failed: async (_pull, sha, checks, attempt) => void events.push(`failed ${sha} #${attempt}: ${checks.map((c) => `${c.context} ${c.url}`)}`),
				stuck: async (_pull, sha) => void events.push(`stuck ${sha}`),
			},
		});
		const red = { state: "failure", total_count: 1, statuses: [{ context: "ci / test", status: "failure", target_url: "/o/r/actions/runs/6/jobs/0" }] };

		await watcher.poll(0); // no status yet: waiting
		status = { state: "pending", total_count: 1 };
		await watcher.poll(60_000);
		status = { state: "success", total_count: 1 };
		await watcher.poll(120_000);
		await watcher.poll(180_000); // the same green commit says nothing twice
		for (const sha of ["sha2", "sha3", "sha4"]) {
			head = sha;
			status = red;
			await watcher.poll(240_000);
			await watcher.poll(300_000);
		}
		assert.deepEqual(events, [
			"passed sha1",
			"failed sha2 #1: ci / test http://forge/o/r/actions/runs/6/jobs/0",
			"failed sha3 #2: ci / test http://forge/o/r/actions/runs/6/jobs/0",
			"stuck sha4",
		]);
		assert.equal(MAX_FIXES, 2);
	});

	it("leaves a merged pull request alone when a newer one on the same branch goes red", async () => {
		const pulls = new Pulls(":memory:");
		pulls.opened({ url: "http://forge/o/r/pulls/7", number: 7, slug: "o/r", kind: "work", conversationId: 9, title: "CI" });
		pulls.opened({ url: "http://forge/o/r/pulls/8", number: 8, slug: "o/r", kind: "work", conversationId: 9, title: "Round mean" });
		const events: string[] = [];
		const watcher = new CiWatcher({
			pulls,
			host: { kind: "forgejo", apiUrl: "http://forge/api/v1", token: "t" },
			fetch: (async (url: string | URL | Request) => {
				const path = new URL(String(url)).pathname;
				// The code host knows #7 was merged; Scout's own record hasn't caught up yet.
				if (path === "/api/v1/repos/o/r/pulls/7") return Response.json({ head: { sha: "new" }, state: "closed" });
				if (path === "/api/v1/repos/o/r/pulls/8") return Response.json({ head: { sha: "new" }, state: "open" });
				if (path === "/api/v1/repos/o/r/commits/new/status") return Response.json({ state: "failure", total_count: 1, statuses: [{ context: "ci", status: "failure" }] });
				return new Response("no", { status: 404 });
			}) as typeof fetch,
			handlers: {
				passed: async (pull) => void events.push(`passed #${pull.number}`),
				failed: async (pull, _sha, _checks, attempt) => void events.push(`failed #${pull.number} try ${attempt}`),
				stuck: async (pull) => void events.push(`stuck #${pull.number}`),
			},
		});
		await watcher.poll(0);
		assert.deepEqual(events, ["failed #8 try 1"]);
	});

	it("stops waiting on a commit nobody reports CI for", async () => {
		const pulls = new Pulls(":memory:");
		pulls.opened({ url: "http://forge/o/r/pulls/5", number: 5, slug: "o/r", kind: "work", conversationId: 9, title: "Docs" });
		let asked = 0;
		const watcher = new CiWatcher({
			pulls,
			host: { kind: "forgejo", apiUrl: "http://forge/api/v1", token: "t" },
			fetch: (async (url: string | URL | Request) => {
				asked++;
				return new URL(String(url)).pathname.endsWith("/status") ? Response.json({ state: "pending", total_count: 0 }) : Response.json({ head: { sha: "s" } });
			}) as typeof fetch,
			handlers: { passed: async () => assert.fail(), failed: async () => assert.fail(), stuck: async () => assert.fail() },
		});
		await watcher.poll(0);
		await watcher.poll(20 * 60_000);
		assert.equal(pulls.ci("http://forge/o/r/pulls/5")?.outcome, "none");
		const before = asked;
		await watcher.poll(21 * 60_000);
		assert.equal(asked, before + 1, "only the pull request is read; its status isn't asked again");
	});
});
