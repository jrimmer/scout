import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CiWatcher } from "../src/ci.ts";
import { forgeFor } from "../src/forge.ts";
import { Pulls } from "../src/pulls.ts";

type Run = { name: string; status: string; conclusion: string | null; html_url?: string };

/** A GitHub whose head commit has the given legacy status and check runs; `asked` lists the paths read. */
function github(status: { state: string; total_count: number }, runs: Run[]) {
	const asked: string[] = [];
	const fetch = (async (url: string | URL | Request) => {
		const path = new URL(String(url)).pathname;
		asked.push(path);
		if (path === "/repos/o/r/pulls/4") return Response.json({ head: { sha: "sha1" }, state: "open" });
		if (path === "/repos/o/r/commits/sha1/status") return Response.json(status);
		if (path === "/repos/o/r/commits/sha1/check-runs") return Response.json({ total_count: runs.length, check_runs: runs });
		return new Response("no", { status: 404 });
	}) as typeof globalThis.fetch;
	return { fetch, asked };
}

async function watch(kind: "github" | "forgejo", fetch: typeof globalThis.fetch) {
	const pulls = new Pulls(":memory:");
	pulls.opened({ url: "https://github.com/o/r/pull/4", number: 4, slug: "o/r", kind: "work", conversationId: 9, title: "Add b" });
	const events: string[] = [];
	const watcher = new CiWatcher({
		pulls,
		host: { kind, apiUrl: kind === "github" ? "https://api.github.test" : "http://forge/api/v1", token: "t" },
		fetch,
		handlers: {
			passed: async () => void events.push("passed"),
			failed: async (_p, _sha, checks) => void events.push(`failed: ${checks.map((c) => `${c.context} ${c.state} ${c.url ?? ""}`).join("; ")}`),
			stuck: async () => void events.push("stuck"),
		},
	});
	await watcher.poll(0);
	return { events, pulls };
}

describe("CI on GitHub reports as check runs", () => {
	const none = { state: "pending", total_count: 0 };
	const run = (name: string, status: string, conclusion: string | null): Run => ({ name, status, conclusion, html_url: `https://github.com/o/r/actions/runs/${name}` });

	it("sees a green GitHub Actions run, which the combined status doesn't show", async () => {
		const { fetch, asked } = github(none, [run("build", "completed", "success"), run("lint", "completed", "skipped")]);
		const { events } = await watch("github", fetch);
		assert.deepEqual(events, ["passed"]);
		assert.ok(asked.includes("/repos/o/r/commits/sha1/check-runs"));
	});

	it("asks the thread to fix a red run, naming it and where to look", async () => {
		const { fetch } = github(none, [run("build", "completed", "success"), run("test", "completed", "failure")]);
		const { events } = await watch("github", fetch);
		assert.deepEqual(events, ["failed: test failure https://github.com/o/r/actions/runs/test"]);
	});

	it("waits while a run is still going, and red beats pending", async () => {
		const waiting = await watch("github", github(none, [run("build", "in_progress", null)]).fetch);
		assert.deepEqual(waiting.events, []);
		assert.equal(waiting.pulls.ci("https://github.com/o/r/pull/4")?.outcome, "pending");
		const red = await watch("github", github(none, [run("build", "in_progress", null), run("test", "completed", "timed_out")]).fetch);
		assert.match(red.events[0]!, /^failed: test timed_out/);
	});

	it("merges a green status with a red run, and a red status with green runs", async () => {
		const a = await watch("github", github({ state: "success", total_count: 1 }, [run("test", "completed", "failure")]).fetch);
		assert.match(a.events[0]!, /^failed: test failure/);
		const b = await watch("github", github({ state: "failure", total_count: 1 }, [run("build", "completed", "success")]).fetch);
		assert.match(b.events[0]!, /^failed:/);
	});

	it("stays pending, not green, when neither has reported yet", async () => {
		const { events, pulls } = await watch("github", github(none, []).fetch);
		assert.deepEqual(events, []);
		assert.equal(pulls.ci("https://github.com/o/r/pull/4")?.outcome, "pending");
	});

	it("leaves Forgejo reading only the status", async () => {
		const asked: string[] = [];
		const fetch = (async (url: string | URL | Request) => {
			const path = new URL(String(url)).pathname;
			asked.push(path);
			if (path === "/api/v1/repos/o/r/pulls/4") return Response.json({ head: { sha: "sha1" } });
			if (path === "/api/v1/repos/o/r/commits/sha1/status") return Response.json({ state: "success", total_count: 1 });
			return new Response("no", { status: 404 });
		}) as typeof globalThis.fetch;
		const { events } = await watch("forgejo", fetch);
		assert.deepEqual(events, ["passed"]);
		assert.ok(!asked.some((p) => p.includes("check-runs")));
	});
});

describe("a pull request's CI state on GitHub (previews)", () => {
	const none = { state: "pending", total_count: 0 };
	const ci = (fetch: typeof globalThis.fetch) => forgeFor({ kind: "github", apiUrl: "https://api.github.test", token: "t" }, fetch).ciState("o/r", "sha1");

	it("reads check runs as well as the status", async () => {
		assert.equal(await ci(github(none, [{ name: "b", status: "completed", conclusion: "success" }]).fetch), "passing");
		assert.equal(await ci(github(none, [{ name: "b", status: "completed", conclusion: "failure" }]).fetch), "failing");
		assert.equal(await ci(github(none, [{ name: "b", status: "queued", conclusion: null }]).fetch), "pending");
		assert.equal(await ci(github(none, []).fetch), undefined);
		assert.equal(await ci(github({ state: "failure", total_count: 1 }, [{ name: "b", status: "completed", conclusion: "success" }]).fetch), "failing");
	});
});
