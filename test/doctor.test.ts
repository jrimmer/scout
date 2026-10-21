import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkCodeHost, checkDashboard, checkDirectory, checkGateway, checkGitRemote, checkSlack, checkSpoond, formatChecks } from "../src/doctor.ts";

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
});
