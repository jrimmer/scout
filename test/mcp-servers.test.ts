import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ciTools } from "../mcp/forgejo-ci.ts";
import { gatusTools } from "../mcp/gatus.ts";

/** A fetch that answers from a table of path → body, and remembers what it was asked. */
function api(routes: Record<string, unknown>) {
	const asked: { path: string; auth: string | null }[] = [];
	const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
		const u = new URL(String(url));
		asked.push({ path: u.pathname + u.search, auth: new Headers(init?.headers).get("authorization") });
		const body = routes[u.pathname];
		if (body === undefined) return new Response("not found", { status: 404 });
		return typeof body === "string" ? new Response(body) : Response.json(body);
	}) as typeof globalThis.fetch;
	return { asked, fetch };
}

const run = (n: number, status: string, ref: string) => ({
	id: 100 + n, index_in_repo: n, title: `change ${n}`, status, event: "push", prettyref: ref, commit_sha: `abcdef${n}0000`,
	workflow_id: "ci.yml", html_url: `https://forge/team/app/actions/runs/${n}`, started: "2026-10-19T01:00:00Z",
});

describe("Scout's MCP servers", () => {
	it("lists a repository's CI runs, filtered by branch and status, with Scout's token", async () => {
		const forge = api({ "/api/v1/repos/team/app/actions/runs": { workflow_runs: [run(3, "failure", "main"), run(2, "success", "feature"), run(1, "failure", "feature")] } });
		const [runs] = ciTools("https://forge/api/v1", "tok", forge.fetch);
		const text = await runs!.run({ repo: "team/app", branch: "feature", status: "failure" });
		assert.match(text, /^#1 \(run 101\) failure · ci\.yml · feature @ abcdef10/);
		assert.doesNotMatch(text, /#2|#3/);
		assert.equal(forge.asked[0]?.auth, "token tok");
		await assert.rejects(runs!.run({ repo: "../../admin" }), /owner\/name/);
	});

	it("shows a job log's matching lines with context, unstamped and with credentials redacted", async () => {
		const log = [
			"2026-10-19T01:00:00.0000000Z setup",
			"2026-10-19T01:00:01.0000000Z npm test",
			"2026-10-19T01:00:02.0000000Z using token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
			"2026-10-19T01:00:03.0000000Z FAIL test/cart.test.ts",
			"2026-10-19T01:00:04.0000000Z done",
			"2026-10-19T01:00:05.0000000Z bye",
		].join("\n");
		const forge = api({ "/api/v1/repos/team/app/actions/jobs/7/logs": log });
		const ciLog = ciTools("https://forge/api/v1", "tok", forge.fetch)[2]!;
		const text = await ciLog.run({ repo: "team/app", job_id: 7, match: "fail" });
		assert.equal(text.split("\n")[0], "2: npm test");
		assert.match(text, /4: FAIL test\/cart\.test\.ts/);
		assert.match(text, /3: using token \[redacted GitHub token\]/);
		assert.doesNotMatch(text, /ghp_abcdef|setup/, "credentials redacted, and only lines near a match");
		assert.match(await ciLog.run({ repo: "team/app", job_id: 7, tail: 2 }), /^… 4 earlier lines\ndone\nbye$/);
	});

	it("puts failing endpoints first and says what failed", async () => {
		const check = (success: boolean, extra = {}) => ({ success, timestamp: "2026-10-20T05:00:00Z", duration: 12e6, status: success ? 200 : 502, ...extra });
		const gatus = api({
			"/api/v1/endpoints/statuses": [
				{ key: "web_home", name: "Home", group: "Web", results: [check(true)] },
				{ key: "web_photos", name: "Photos", group: "Web", results: [check(false, { conditionResults: [{ condition: "[STATUS] < 400", success: false }] })] },
			],
			"/api/v1/endpoints/web_photos/statuses": { key: "web_photos", name: "Photos", group: "Web", results: [check(true), check(false)] },
		});
		const [overview, history] = gatusTools("http://gatus", gatus.fetch);
		const text = await overview!.run({});
		assert.deepEqual(text.split("\n").slice(0, 2), ["2 endpoints, 1 failing.", "Web / Photos [web_photos]: DOWN · HTTP 502 · 12 ms · failed: [STATUS] < 400 at 2026-10-20T05:00:00Z"]);
		assert.equal(await overview!.run({ failing_only: true }), "2 endpoints, 1 failing.\nWeb / Photos [web_photos]: DOWN · HTTP 502 · 12 ms · failed: [STATUS] < 400 at 2026-10-20T05:00:00Z");
		assert.match(await history!.run({ key: "web_photos", limit: 5 }), /^Web \/ Photos:\n.*up · HTTP 200.*\n.*DOWN · HTTP 502/);
		assert.equal(gatus.asked.at(-1)?.path, "/api/v1/endpoints/web_photos/statuses?page=1&pageSize=5");
	});
});
