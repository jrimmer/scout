import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.ts";
import { checkBackups, reachHint, checkCodeHost, checkDashboard, checkDirectory, checkGateway, checkGitRemote, checkModel, checkProfileDir, checkRestarts, checkRunning, checkSlack, checkSpoond, doctor, fetchRunning, formatChecks, restartsOf, type Running, unitOf } from "../src/doctor.ts";

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

	it("says what a failed connection probably means, from the cause under \"fetch failed\"", async () => {
		const failed = (code: string, message = code) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(message), { code }) });
		assert.match(reachHint(failed("ECONNREFUSED"), "http://forge:3000/api/v1") ?? "", /Nothing is listening.*port/);
		assert.match(reachHint(failed("ENOTFOUND"), "http://forgee/api/v1") ?? "", /host name doesn't resolve/);
		assert.match(reachHint(failed("ECONNRESET"), "https://forge:3000/api/v1") ?? "", /serves plain http.*try http:\/\//);
		assert.match(reachHint(failed("EPROTO", "wrong version number"), "https://forge:3000/api/v1") ?? "", /try http:\/\//);
		assert.match(reachHint(failed("ECONNRESET"), "http://forge/api/v1") ?? "", /needs https.*try https:\/\//);
		assert.match(reachHint(failed("DEPTH_ZERO_SELF_SIGNED_CERT"), "https://forge/api/v1") ?? "", /certificate/);
		assert.match(reachHint(failed("UND_ERR_CONNECT_TIMEOUT"), "http://forge/api/v1") ?? "", /in time/);
		assert.equal(reachHint(new Error("boom"), "http://forge"), undefined);
		const host = { kind: "forgejo", apiUrl: "http://forge:3000/api/v1", token: "t" } as const;
		const refused = await checkCodeHost(host, answering({ "http://forge:3000/api/v1/user": failed("ECONNREFUSED") }));
		assert.deepEqual([refused.status, refused.detail], ["fail", "can't reach http://forge:3000/api/v1 (fetch failed)"]);
		assert.match(refused.fix ?? "", /Nothing is listening/);
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

	it("says why a repository can't be reached, in the remote's own words, with a hint for the cause", async () => {
		const failing = (stderr: string) => async () => Promise.reject(Object.assign(new Error(`Command failed: ls-remote\n${stderr}`), { stderr }));
		const hostKey = await checkGitRemote("Repository web", "ssh://git@host/o/web.git", "main", failing("Host key verification failed.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n"));
		assert.equal(hostKey.detail, "can't reach ssh://git@host/o/web.git (Host key verification failed.)");
		assert.match(hostKey.fix ?? "", /ssh-keyscan/);
		const denied = await checkGitRemote("Repository web", "ssh://git@host/o/web.git", "main", failing("git@host: Permission denied (publickey).\nfatal: Could not read from remote repository.\n"));
		assert.match(denied.detail, /Permission denied \(publickey\)/);
		assert.match(denied.fix ?? "", /public key to Scout's code host account/);
		const dns = await checkGitRemote("Repository web", "ssh://git@nohost/o/web.git", "main", failing("ssh: Could not resolve hostname nohost: Name or service not known\nfatal: Could not read from remote repository.\n"));
		assert.match(dns.fix ?? "", /reach it/);
	});

	it("fails the profile directory start-up would refuse, and passes one it can clone into", () => {
		const root = mkdtempSync(join(tmpdir(), "scout-doctor-"));
		const url = "ssh://git@host/o/profile.git";
		mkdirSync(join(root, "example"));
		writeFileSync(join(root, "example", "system.md"), "x");
		const bad = checkProfileDir(join(root, "example"), url);
		assert.equal(bad.status, "fail");
		assert.match(bad.detail, /exists but is not a clone of ssh:\/\/git@host\/o\/profile.git/);
		assert.equal(checkProfileDir(join(root, "new"), url).status, "ok");
		mkdirSync(join(root, "clone", ".git"), { recursive: true });
		assert.equal(checkProfileDir(join(root, "clone"), url).detail, `${join(root, "clone")} (a clone)`);
	});

	it("asks the configured model for a short answer, and says why when it won't give one", async () => {
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m" }] });
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([fauxAssistantMessage("ok")]);
		assert.deepEqual(await checkModel(models, { provider: "faux", modelId: "m" }), { name: "Model", status: "ok", detail: "faux/m answers" });
		faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: '401 {"error":{"message":"invalid x-api-key"}}' })]);
		const key = await checkModel(models, { provider: "faux", modelId: "m" });
		assert.deepEqual([key.status, key.detail], ["fail", "faux/m refused the key (invalid x-api-key)"]);
		assert.match(key.fix ?? "", /ANTHROPIC_API_KEY/);
		faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: '404 {"error":{"message":"model: nope"}}' })]);
		const missing = await checkModel(models, { provider: "faux", modelId: "m" });
		assert.match(missing.detail, /wasn't found \(model: nope\)/);
		assert.match(missing.fix ?? "", /SCOUT_MODEL/);
		const unknown = await checkModel(models, { provider: "faux", modelId: "other" });
		assert.equal(unknown.detail, "faux/other isn't a model Scout knows");
	});

	it("refuses a dashboard open to the network without a login", () => {
		assert.equal(checkDashboard({ addr: "127.0.0.1:8893" }).status, "ok");
		assert.equal(checkDashboard({ addr: "0.0.0.0:8893" }).status, "fail");
		assert.equal(checkDashboard({ addr: "0.0.0.0:8893", auth: { user: "u", passwordHash: "h" } }).status, "ok");
		assert.equal(checkDashboard(undefined).detail, "off");
	});

	it("fails when Scout's data isn't backed up off the machine, and only warns when that's on purpose", () => {
		assert.deepEqual(checkBackups({ status: "ok", problems: [] }), { name: "Backups", status: "ok", detail: "Litestream is copying pi.sqlite and scout.sqlite" });
		const missing = checkBackups({ status: "missing", problems: ["no Litestream copy of pi.sqlite"] });
		assert.deepEqual([missing.status, missing.detail], ["fail", "Scout's data isn't backed up off this machine: no Litestream copy of pi.sqlite"]);
		assert.match(missing.fix ?? "", /docs\/operations\.md#backups/);
		const off = checkBackups({ status: "off", problems: [] });
		assert.deepEqual([off.status, off.detail], ["warn", "backups off, on purpose (SCOUT_BACKUP=none)"]);
	});

	it("warns when the service won't start Scout again after a drain, and skips without systemd", async () => {
		const unit = { name: "scout.service", user: false };
		const waits = "ExecStartPre={ path=/usr/bin/flock ; argv[]=/usr/bin/flock /opt/scout/.deploy.lock true ; ignore_errors=no }";
		assert.equal(checkRestarts(unit, `LoadState=loaded\nRestart=always\n${waits}\n`, "/opt/scout")?.status, "ok");
		const noLock = checkRestarts(unit, "LoadState=loaded\nRestart=always\nExecStartPre=\n", "/opt/scout");
		assert.deepEqual([noLock?.status, noLock?.detail], ["warn", "the scout.service unit doesn't wait for the deploy lock, so systemd could start Scout on half-updated code"]);
		assert.match(noLock?.fix ?? "", /ExecStartPre=\/usr\/bin\/flock \/opt\/scout\/\.deploy\.lock true\n {4}TimeoutStartSec=15min/);
		assert.equal(checkRestarts(unit, `LoadState=loaded\nRestart=always\n${waits}\n`, "/srv/other")?.status, "warn", "a lock in another directory isn't this one's");
		const onFailure = checkRestarts(unit, "LoadState=loaded\nRestart=on-failure\n");
		assert.deepEqual([onFailure?.status, onFailure?.detail], ["warn", "the scout.service unit has Restart=on-failure, so a drain for a deploy leaves Scout stopped"]);
		assert.match(onFailure?.fix ?? "", /Restart=always.*systemctl daemon-reload/);
		assert.equal(checkRestarts({ name: "scout", user: false }, "LoadState=not-found\nRestart=no\n"), undefined, "no such unit on this machine");
		let asked: string[] = [];
		const show = async (args: string[]) => {
			asked = args;
			return "LoadState=loaded\nRestart=no\n";
		};
		assert.match((await restartsOf({ name: "scout.service", user: true }, show))?.fix ?? "", /systemctl --user daemon-reload/);
		assert.deepEqual(asked, ["--user", "show", "scout.service", "-p", "LoadState", "-p", "Restart", "-p", "ExecStartPre"]);
		assert.equal(await restartsOf(undefined, show), undefined);
		assert.equal(await restartsOf(unit, async () => Promise.reject(new Error("systemctl: not found"))), undefined);
	});

	it("asks the running Scout about backups first, since a unit can set its data directory outside .env", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "scout-doctor-"));
		const env = { SCOUT_REPO_URL: "git@host:o/web.git", SCOUT_REPO_SLUG: "o/web", SCOUT_CODEHOST_TOKEN: "t", SCOUT_CODEHOST_API: "http://forge/api/v1", SCOUT_DATA_DIR: dataDir, SCOUT_DASH_ADDR: "off" };
		const deps = { fetch: answering({}), git: async () => "abc\trefs/heads/main\n" };
		const ran = (running: Running | Error) => ({ ...deps, running: async () => (running instanceof Error ? Promise.reject(running) : running) });
		const named = (checks: { name: string; status: string; detail: string }[], name: string) => checks.find((c) => c.name === name);
		const backedUp = await doctor(loadConfig(env), ran(running({ backup: { status: "ok", problems: [] } })));
		assert.equal(named(backedUp, "Backups")?.status, "ok");
		assert.deepEqual(backedUp.slice(-2).map((c) => c.name), ["Backups", "Running"]);
		const local = named(await doctor(loadConfig(env), ran(new Error("ECONNREFUSED"))), "Backups");
		assert.deepEqual([local?.status, local?.detail], ["fail", `Scout's data isn't backed up off this machine: there's no pi.sqlite in ${dataDir}; there's no scout.sqlite in ${dataDir}`]);
		assert.equal(named(await doctor(loadConfig({ ...env, SCOUT_BACKUP: "none" }), deps), "Backups")?.status, "warn");
		const restarts = await doctor(loadConfig(env), { ...deps, restarts: async () => ({ name: "Restarts", status: "warn" as const, detail: "Restart=no" }) });
		assert.deepEqual(restarts.slice(-2).map((c) => c.name), ["Backups", "Restarts"]);
		assert.throws(() => loadConfig({ ...env, SCOUT_BACKUP: "s3" }), /SCOUT_BACKUP must be litestream or none/);
	});

	it("finds the unit Scout runs in from its cgroup, only when systemd started it", () => {
		const env = { INVOCATION_ID: "abc" };
		assert.deepEqual(unitOf("0::/system.slice/scout.service\n", env), { name: "scout.service", user: false });
		assert.deepEqual(unitOf("0::/user.slice/user-1000.slice/user@1000.service/app.slice/scout.service\n", env), { name: "scout.service", user: true });
		assert.equal(unitOf("0::/user.slice/user-1000.slice/session-2.scope\n", env), undefined);
		assert.equal(unitOf("0::/system.slice/scout.service\n", {}), undefined);
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
		const unasked = checkRunning(await fetchRunning(undefined, undefined, doFetch).catch((error: Error) => error));
		assert.deepEqual([unasked[0]!.status, unasked[0]!.detail], ["warn", "can't ask the running Scout: its dashboard is off (SCOUT_DASH_ADDR), so there's nothing to ask"], "a setup without a dashboard isn't Scout down");
	});
});
