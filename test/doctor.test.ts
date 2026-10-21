import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkCodeHost, checkDashboard, checkDirectory, checkGateway, checkGitRemote, checkRunning, checkSlack, checkSpoond, fetchRunning, formatChecks, type Running } from "../src/doctor.ts";

/** A fetch that answers by URL: a status, a JSON body, and headers. */
function answering(routes: Record<string, { status?: number; body?: unknown; headers?: Record<string, string> } | Error>): typeof fetch {
	return (async (url: string | URL | Request) => {
		const route = Object.entries(routes).find(([prefix]) => String(url).startsWith(prefix))?.[1];
		if (route === undefined) return new Response("no", { status: 404 });
		if (route instanceof Error) throw route;
		return Response.json(route.body ?? {}, { status: route.status ?? 200, headers: route.headers ?? {} });
	}) as typeof fetch;
}

const ALL_SCOPES = "chat:write,channels:history,channels:read,users:read,reactions:read,files:write,users:read.email,reactions:write,commands,links:read,links:write,canvases:write,lists:write";

describe("doctor", () => {
	it("checks Slack's token and scopes: core ones missing is broken, feature ones a warning", async () => {
		const ok = await checkSlack("xoxb", answering({ "https://slack.com": { body: { ok: true, team: "Acme", user: "scout" }, headers: { "x-oauth-scopes": ALL_SCOPES } } }));
		assert.deepEqual([ok.status, ok.detail], ["ok", "signed in as scout in Acme, with every scope"]);
		const partly = await checkSlack("xoxb", answering({ "https://slack.com": { body: { ok: true, team: "Acme", user: "scout" }, headers: { "x-oauth-scopes": "chat:write,channels:history,channels:read,users:read,reactions:read" } } }));
		assert.equal(partly.status, "warn");
		assert.match(partly.detail, /off for want of scopes: long answers attached in full/);
		const core = await checkSlack("xoxb", answering({ "https://slack.com": { body: { ok: true }, headers: { "x-oauth-scopes": "chat:write" } } }));
		assert.deepEqual([core.status, core.detail], ["fail", "missing channels:history, channels:read, users:read, reactions:read"]);
		assert.equal((await checkSlack("xoxb", answering({ "https://slack.com": { body: { ok: false, error: "invalid_auth" } } }))).detail, "Slack refused the token (invalid_auth)");
		assert.equal((await checkSlack("", answering({}))).status, "fail");
	});

	it("checks the code host's token, and on Forgejo that it can read notifications", async () => {
		const host = { kind: "forgejo" as const, apiUrl: "http://forge/api/v1", token: "t" };
		const ok = await checkCodeHost(host, answering({ "http://forge/api/v1/user": { body: { login: "scout" } }, "http://forge/api/v1/notifications": { body: [] } }));
		assert.deepEqual([ok.status, ok.detail], ["ok", "signed in as scout, with notifications"]);
		const noInbox = await checkCodeHost(host, answering({ "http://forge/api/v1/user": { body: { login: "scout" } }, "http://forge/api/v1/notifications": { status: 403 } }));
		assert.equal(noInbox.status, "warn");
		assert.match(noInbox.fix ?? "", /write:notification/);
		assert.equal((await checkCodeHost(host, answering({ "http://forge/api/v1/user": { status: 401 } }))).status, "fail");
		const github = await checkCodeHost({ kind: "github", apiUrl: "https://api.github.com", token: "t" }, answering({ "https://api.github.com/user": { body: { login: "scout" }, headers: { "x-oauth-scopes": "repo" } } }));
		assert.deepEqual([github.status, github.detail], ["warn", "signed in as scout; the token lacks notifications"]);
	});

	it("checks spoond, the model gateway, the directory and git remotes", async () => {
		assert.equal((await checkSpoond("https://sb:8890", "t", answering({ "https://sb:8890/api/users/me": { body: { share: { name: "scout" } } } }))).detail, "signed in as scout");
		assert.match((await checkSpoond("https://sb:8890", "t", answering({ "https://sb:8890": new Error("ECONNREFUSED") }))).detail, /can't reach https:\/\/sb:8890 \(ECONNREFUSED\)/);
		const gateway = { url: "https://llm/v1", key: "k" };
		assert.equal((await checkGateway(gateway, ["lunaroute/deepseek"], answering({ "https://llm/v1/models": { body: { data: [{ id: "lunaroute/deepseek" }] } } }))).detail, "answers, with 1 models");
		assert.equal((await checkGateway(gateway, ["other/model"], answering({ "https://llm/v1/models": { body: { data: [{ id: "lunaroute/deepseek" }] } } }))).status, "warn");
		assert.equal((await checkDirectory(async () => "users:\n  ann:\n    email: ann@x\n    groups: [admins]\n")).detail, "1 people");
		assert.equal((await checkDirectory(async () => Promise.reject(new Error("404")))).status, "fail");
		assert.equal((await checkGitRemote("Repository web", "git@host:o/web.git", "main", async () => "abc\trefs/heads/main\n")).status, "ok");
		assert.equal((await checkGitRemote("Repository web", "git@host:o/web.git", "main", async () => "")).detail, "git@host:o/web.git has no main branch");
	});

	it("refuses a dashboard open to the network without a login", () => {
		assert.equal(checkDashboard({ addr: "127.0.0.1:8893" }).status, "ok");
		assert.equal(checkDashboard({ addr: "0.0.0.0:8893" }).status, "fail");
		assert.equal(checkDashboard({ addr: "0.0.0.0:8893", auth: { user: "u", passwordHash: "h" } }).status, "ok");
		assert.equal(checkDashboard(undefined).detail, "off");
	});

	it("prints one line per check, with the fix under it", () => {
		assert.equal(
			formatChecks([
				{ name: "Slack", status: "ok", detail: "fine" },
				{ name: "spoond", status: "fail", detail: "down", fix: "Start it." },
			]),
			"✅ Slack: fine\n❌ spoond: down\n    Start it.",
		);
	});

	const HOUR = 3_600_000;
	const capacity = { active: 1, maxRuns: 8, queued: 0, modelInFlight: 0, modelWaiting: 0, modelMax: 6, sandboxes: 1, sandboxWaiting: 0, progressWaiting: 0, loopLag: { mean: 1, p99: 5 }, waits: [] };
	const running = (over: Partial<Running> = {}): Running => ({ now: 10 * HOUR, startedAt: 7 * HOUR, alerts: [], working: [], capacity, ...over });

	it("checks the running Scout: up and keeping up is one line", () => {
		assert.deepEqual(checkRunning(running({ working: [{ channel: "web", startedAt: 9 * HOUR, steps: 3 }] })), [{ name: "Running", status: "ok", detail: "up 3h, 1 working" }]);
	});

	it("fails only on what needs a person now: Scout not answering, or a problem that has lasted an hour", () => {
		const down = checkRunning(new Error("connect ECONNREFUSED 127.0.0.1:8893"));
		assert.deepEqual([down[0]!.status, down[0]!.detail], ["fail", "Scout isn't answering: connect ECONNREFUSED 127.0.0.1:8893"]);
		const problems = checkRunning(running({ alerts: [{ message: "reflection failed", since: 8 * HOUR }, { message: "Gatus unreachable", since: 9.5 * HOUR }] })).filter((c) => c.name === "Problem");
		assert.deepEqual(problems.map((c) => [c.status, c.detail]), [["fail", "reflection failed (for 2h)"], ["warn", "Gatus unreachable (for 30m)"]]);
	});

	it("warns about slowness, and says where it comes from", () => {
		const slow = checkRunning(running({
			working: [{ channel: "web", startedAt: 7.5 * HOUR, steps: 40, lastStep: "bash" }],
			capacity: { ...capacity, queued: 2, sandboxWaiting: 1, loopLag: { mean: 300, p99: 1500 }, waits: [{ kind: "run", count: 5, p50: 60_000, p90: 20 * 60_000 }], firstToken: { count: 40, p50: 22_000, p90: 72_000 } },
		}));
		assert.deepEqual(slow.map((c) => [c.name, c.status]), [["Running", "ok"], ["Long run", "warn"], ["Waiting", "warn"], ["Model", "warn"], ["Sandboxes", "warn"], ["Event loop", "warn"]]);
		assert.equal(slow[0]!.detail, "up 3h, 1 working, 2 waiting their turn");
		assert.equal(slow[1]!.detail, "a thread in #web has been working for 2h30 (40 steps, last: bash)");
		assert.equal(slow[3]!.detail, "slow to start answering: half of 40 calls in the last day waited over 22s, the slowest tenth over 1m");
		assert.match(slow[3]!.fix ?? "", /not Scout/);
		assert.ok(!checkRunning(running({ capacity: { ...capacity, firstToken: { count: 5, p50: 60_000, p90: 90_000 } } })).some((c) => c.name === "Model"), "a handful of slow calls isn't a trend");
	});

	it("asks the running Scout through its dashboard, with the metrics token", async () => {
		let asked: { url: string; auth: string | null } | undefined;
		const doFetch = (async (url: string | URL | Request, init?: RequestInit) => {
			asked = { url: String(url), auth: new Headers(init?.headers).get("authorization") };
			return Response.json(running());
		}) as typeof fetch;
		assert.equal((await fetchRunning({ addr: "0.0.0.0:8893", auth: { user: "ops", passwordHash: "x" } }, "tok", doFetch)).startedAt, 7 * HOUR);
		assert.deepEqual(asked, { url: "http://127.0.0.1:8893/status.json", auth: "Bearer tok" });
		await assert.rejects(fetchRunning(undefined, "tok", doFetch), /dashboard is off/);
		await assert.rejects(fetchRunning({ addr: "0.0.0.0:8893", auth: { user: "ops", passwordHash: "x" } }, undefined, doFetch), /SCOUT_METRICS_TOKEN/);
	});
});
