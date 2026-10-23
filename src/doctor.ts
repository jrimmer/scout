import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { type Backup, backupState, describeBackup } from "./backups.ts";
import { isIP } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { NEEDS } from "./capabilities.ts";
import type { CodeHost } from "./codehost.ts";
import type { Config } from "./config.ts";
import { loadRoles, parseAutheliaUsers, requestersOf, type Roles } from "./directory.ts";
import type { GatewayConfig } from "./gateway.ts";
import { profileDirProblem } from "./profile.ts";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Snapshot } from "./dash/collect.ts";

const run = promisify(execFile);

/**
 * Is everything Scout depends on reachable and set up right? One check per integration it can try, each with how to fix what
 * isn't: for whoever installs Scout, and for "why isn't it doing X?". `npm run doctor` and `/scout doctor` run the same.
 */
export type Check = { name: string; status: "ok" | "warn" | "fail"; detail: string; fix?: string };

const ICONS = { ok: "✅", warn: "⚠️", fail: "❌" } as const;

export function formatChecks(checks: readonly Check[]): string {
	return checks.map((c) => `${ICONS[c.status]} ${c.name}: ${c.detail}${c.fix === undefined ? "" : `\n    ${c.fix}`}`).join("\n");
}

/** Scopes Scout can't work without; the rest turn features on (capabilities.ts). */
const CORE_SCOPES = ["chat:write", "channels:history", "channels:read", "users:read", "reactions:read"];

export async function checkSlack(token: string, doFetch: typeof fetch = fetch): Promise<Check> {
	const name = "Slack";
	if (token === "") return { name, status: "fail", detail: "no bot token", fix: "Set SLACK_BOT_TOKEN (Install App → Bot User OAuth Token)." };
	const response = await doFetch("https://slack.com/api/auth.test", { method: "POST", headers: { authorization: `Bearer ${token}` } }).catch((error: unknown) => error as Error);
	if (response instanceof Error) return { name, status: "fail", detail: `can't reach Slack (${response.message})` };
	const body = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string; team?: string; user?: string };
	if (body.ok !== true) return { name, status: "fail", detail: `Slack refused the token (${body.error ?? response.status})`, fix: "Check SLACK_BOT_TOKEN; reinstall the app if it was revoked." };
	const granted = new Set((response.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim()));
	const core = CORE_SCOPES.filter((s) => !granted.has(s));
	if (core.length > 0) return { name, status: "fail", detail: `missing ${core.join(", ")}`, fix: "Update the app from slack-manifest.yaml and reinstall it." };
	const off = Object.values(NEEDS).filter((n) => n.scopes.some((s) => !granted.has(s)));
	if (off.length > 0) {
		return { name, status: "warn", detail: `signed in as ${body.user} in ${body.team}, but these are off for want of scopes: ${off.map((n) => n.what).join("; ")}`, fix: "Update the app from slack-manifest.yaml and reinstall it." };
	}
	return { name, status: "ok", detail: `signed in as ${body.user} in ${body.team}, with every scope` };
}

export async function checkCodeHost(host: CodeHost, doFetch: typeof fetch = fetch): Promise<Check> {
	const name = host.kind === "github" ? "GitHub" : "Forgejo";
	if (host.apiUrl === "") return { name, status: "fail", detail: "no API address", fix: "Set SCOUT_CODEHOST_API (Forgejo: https://<host>/api/v1)." };
	const headers = { accept: host.kind === "github" ? "application/vnd.github+json" : "application/json", authorization: host.kind === "github" ? `Bearer ${host.token}` : `token ${host.token}` };
	const user = await doFetch(`${host.apiUrl}/user`, { headers }).catch((error: unknown) => error as Error);
	if (user instanceof Error) return { name, status: "fail", detail: `can't reach ${host.apiUrl} (${user.message})`, ...hint(user, host.apiUrl) };
	if (!user.ok) return { name, status: "fail", detail: `the token was refused (${user.status})`, fix: "Check SCOUT_CODEHOST_TOKEN." };
	const login = ((await user.json().catch(() => ({}))) as { login?: string }).login ?? "?";
	if (host.kind === "github") {
		const scopes = (user.headers.get("x-oauth-scopes") ?? "").split(",").map((s) => s.trim());
		// Fine-grained tokens report no scopes; only classic ones can be checked this way.
		if (scopes.length > 1 || scopes[0] !== "") {
			const missing = ["repo", "notifications"].filter((s) => !scopes.includes(s));
			if (missing.length > 0) return { name, status: "warn", detail: `signed in as ${login}; the token lacks ${missing.join(", ")}`, fix: "Give the token repo and notifications, or the code host inbox and pushes won't work." };
		}
		return { name, status: "ok", detail: `signed in as ${login}` };
	}
	const notifications = await doFetch(`${host.apiUrl}/notifications?limit=1`, { headers }).catch(() => undefined);
	if (notifications?.ok !== true) {
		return { name, status: "warn", detail: `signed in as ${login}, but the token can't read notifications`, fix: "Give the token write:notification (and write:issue, write:repository, read:user), or work from the code host won't arrive." };
	}
	return { name, status: "ok", detail: `signed in as ${login}, with notifications` };
}

/**
 * Who may ask for work. Off (or only warning), anyone in a public channel Scout is in may; and on a repository anyone
 * can read on the code host, anyone at all who can comment there. The roles file's `request` groups narrow a repository
 * whatever the mode, so those count as checked.
 */
export async function checkRequesters(config: Config, doFetch: typeof fetch = fetch): Promise<Check> {
	const name = "Requester check";
	const mode = config.governance.requesterCheck;
	if (mode === "enforce") return { name, status: "ok", detail: "only people who may change a repository can ask for work in it" };
	let roles: Roles = {};
	try {
		roles = loadRoles(config.governance.rolesFile);
	} catch {
		// The roles file has a check of its own at start-up; here it narrows nothing.
	}
	const open = config.repos.filter((r) => requestersOf(roles, r.name) === undefined);
	if (open.length === 0) return { name, status: "ok", detail: `${mode}, but the roles file says who may ask for work in every repository` };
	const host = config.codeHost;
	const headers = { accept: host.kind === "github" ? "application/vnd.github+json" : "application/json", authorization: host.kind === "github" ? `Bearer ${host.token}` : `token ${host.token}` };
	const isPublic = async (slug: string) => {
		const response = await doFetch(`${host.apiUrl}/repos/${slug}`, { headers }).catch(() => undefined);
		if (response?.ok !== true) return false;
		return ((await response.json().catch(() => ({}))) as { private?: boolean }).private === false;
	};
	const publicRepos: string[] = [];
	for (const r of open) if (await isPublic(r.slug)) publicRepos.push(r.slug);
	const fix = "Set SCOUT_REQUESTER_CHECK=enforce, or name who may ask in the roles file (docs/setup.md, step 8).";
	if (publicRepos.length > 0) {
		return { name, status: "fail", detail: `${mode}, and ${publicRepos.join(", ")} ${publicRepos.length === 1 ? "is" : "are"} public: anyone who can comment there can make me work`, fix };
	}
	return { name, status: "warn", detail: `${mode}: anyone in a public channel I'm in may ask me for work`, fix: `${fix} Off is fine for a test install.` };
}

export async function checkSpoond(url: string, token: string, doFetch: typeof fetch = fetch): Promise<Check> {
	const name = "spoond";
	const response = await doFetch(`${url.replace(/\/$/, "")}/api/users/me`, { headers: { authorization: `Bearer ${token}` } }).catch((error: unknown) => error as Error);
	if (response instanceof Error) return { name, status: "fail", detail: `can't reach ${url} (${response.message})`, ...hint(response, url) };
	if (!response.ok) return { name, status: "fail", detail: `the token was refused (${response.status})`, fix: "Check SCOUT_SPOOND_TOKEN (or the file it names)." };
	const me = (await response.json().catch(() => ({}))) as { share?: { name?: string }; user?: { name?: string } };
	return { name, status: "ok", detail: `signed in as ${me.share?.name ?? me.user?.name ?? "?"}` };
}

export async function checkGateway(gateway: GatewayConfig, wanted: readonly string[], doFetch: typeof fetch = fetch): Promise<Check> {
	const name = "Model gateway";
	const response = await doFetch(`${gateway.url}/models`, {
		headers: { ...(gateway.key === undefined ? {} : { authorization: `Bearer ${gateway.key}` }), ...gateway.headers },
	}).catch((error: unknown) => error as Error);
	if (response instanceof Error) return { name, status: "fail", detail: `can't reach ${gateway.url} (${response.message})`, ...hint(response, gateway.url) };
	if (!response.ok) return { name, status: "fail", detail: `${gateway.url} answered ${response.status}`, fix: "Check SCOUT_GATEWAY_URL and SCOUT_GATEWAY_KEY." };
	const listed = new Set((((await response.json().catch(() => ({}))) as { data?: { id?: string }[] }).data ?? []).flatMap((m) => (m.id === undefined ? [] : [m.id])));
	const missing = wanted.filter((m) => listed.size > 0 && !listed.has(m));
	if (missing.length > 0) return { name, status: "warn", detail: `answers, but doesn't list ${missing.join(", ")}`, fix: "Check SCOUT_MODEL and SCOUT_GATEWAY_MODELS against what the gateway serves." };
	return { name, status: "ok", detail: `answers${listed.size === 0 ? "" : `, with ${listed.size} models`}` };
}

export async function checkDirectory(read: () => Promise<string>): Promise<Check> {
	const name = "Directory";
	try {
		const people = parseAutheliaUsers(await read());
		if (people.length === 0) return { name, status: "warn", detail: "readable, but lists nobody", fix: "Check SCOUT_DIRECTORY_SOURCE points at the users file." };
		return { name, status: "ok", detail: `${people.length} people` };
	} catch (error) {
		return { name, status: "fail", detail: `can't read it (${error instanceof Error ? error.message : String(error)})`, fix: "Check SCOUT_DIRECTORY_SOURCE, and that Scout's code host account can read it." };
	}
}

/** A git remote answers for `branch`, with Scout's own SSH key (useScoutsKey). */
export async function checkGitRemote(name: string, gitUrl: string, branch: string, git: (args: string[]) => Promise<string> = gitOut): Promise<Check> {
	try {
		const heads = await git(["ls-remote", "--heads", gitUrl, branch]);
		if (heads.trim() === "") return { name, status: "fail", detail: `${gitUrl} has no ${branch} branch` };
		return { name, status: "ok", detail: `${gitUrl} (${branch})` };
	} catch (error) {
		const why = gitReason(error);
		return { name, status: "fail", detail: `can't reach ${gitUrl} (${why})`, fix: gitHint(why) };
	}
}

/** The profile repository's clone: start-up refuses a directory that holds something else, so the doctor says so first. */
export function checkProfileDir(dir: string, gitUrl: string): Check {
	const name = "Profile directory";
	const problem = profileDirProblem(dir, gitUrl);
	if (problem !== undefined) return { name, status: "fail", detail: problem, fix: "Leave SCOUT_PROFILE_DIR unset (Scout clones the profile under its data directory), or give it a path that doesn't exist yet." };
	return { name, status: "ok", detail: existsSync(join(dir, ".git")) ? `${dir} (a clone)` : `${dir} (Scout clones the profile there at its first start)` };
}

/** One request, a few tokens, through the same models and gateway Scout uses: does the configured model answer? */
export async function checkModel(models: Models, model: Config["model"], timeoutMs = 20_000): Promise<Check> {
	const name = "Model";
	const which = `${model.provider}/${model.modelId}`;
	const found = models.getModel(model.provider, model.modelId);
	if (found === undefined) return { name, status: "fail", detail: `${which} isn't a model Scout knows`, fix: "Check SCOUT_MODEL (provider/modelId); for a model only your gateway serves, use gateway/<its name> and list it in SCOUT_GATEWAY_MODELS." };
	const reply: { stopReason: string; errorMessage?: string } = await models
		.completeSimple(found, { messages: [{ role: "user", content: "Reply with the word ok.", timestamp: Date.now() }] }, { maxTokens: 16, signal: AbortSignal.timeout(timeoutMs) })
		.catch((error: unknown) => ({ stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) }));
	if (reply.stopReason !== "error" && reply.stopReason !== "aborted") return { name, status: "ok", detail: `${which} answers` };
	const why = reply.errorMessage ?? "no reason given";
	const reason = why.match(/"message"\s*:\s*"([^"]+)"/)?.[1] ?? why.split("\n")[0]!.slice(0, 200);
	if (reply.stopReason === "aborted" || /abort|timed? ?out/i.test(why)) return { name, status: "fail", detail: `${which} didn't answer within ${Math.round(timeoutMs / 1000)}s`, fix: "Check the provider's status and, through a gateway, SCOUT_GATEWAY_URL." };
	if (/\b40[13]\b|unauthori|invalid.*key|api key|authenticat/i.test(why)) return { name, status: "fail", detail: `${which} refused the key (${reason})`, fix: "Check the provider's key (ANTHROPIC_API_KEY or OPENAI_API_KEY), or SCOUT_GATEWAY_KEY through a gateway." };
	if (/\b404\b|not.?found|no such model|does not exist/i.test(why)) return { name, status: "fail", detail: `${which} wasn't found (${reason})`, fix: "Check SCOUT_MODEL against the names the provider or gateway serves." };
	return { name, status: "fail", detail: `${which} didn't answer (${reason})`, fix: "Check the provider's status, the key, and SCOUT_GATEWAY_URL if there is one." };
}

export function checkDashboard(dash: Config["dash"]): Check {
	const name = "Dashboard";
	if (dash === undefined) return { name, status: "ok", detail: "off" };
	const host = dash.addr.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
	const loopback = host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
	if (!loopback && dash.auth === undefined) {
		return { name, status: "fail", detail: `${dash.addr} is reachable from the network without a login`, fix: "Set SCOUT_DASH_USER and SCOUT_DASH_PASSWORD_HASH (npm run dash-password), or listen on 127.0.0.1." };
	}
	return { name, status: "ok", detail: `${dash.addr}${loopback ? " (this machine only)" : ", behind a login"}` };
}

/** Whether Scout's databases are backed up off this machine (backups.ts): not is broken, off on purpose a warning. */
export function checkBackups(backup: Backup): Check {
	const name = "Backups";
	if (backup.status === "ok") return { name, status: "ok", detail: describeBackup(backup) };
	if (backup.status === "off") return { name, status: "warn", detail: describeBackup(backup), fix: "Fine for a test install. Anywhere people rely on Scout, run Litestream beside it: docs/operations.md#backups." };
	return { name, status: "fail", detail: describeBackup(backup), fix: "Run Litestream as a service beside Scout (deploy/litestream.yml, deploy/litestream.service.d/scout.conf), and check `systemctl status litestream`: docs/operations.md#backups. For a test install, SCOUT_BACKUP=none says it's on purpose." };
}

/** A systemd unit, and whether it's a user's (`systemctl --user`). */
export type Unit = { name: string; user: boolean };

/** The unit this process runs in, from `/proc/self/cgroup`, when systemd started it (INVOCATION_ID): Scout under its service. */
export function unitOf(cgroup: string, env: NodeJS.ProcessEnv = process.env): Unit | undefined {
	if (env.INVOCATION_ID === undefined) return undefined;
	const path = cgroup.split("\n").find((l) => l.startsWith("0::"))?.slice(3).trim() ?? "";
	const name = path.split("/").pop() ?? "";
	return name.endsWith(".service") ? { name, user: path.includes("/user@") } : undefined;
}

/**
 * A drain for a deploy (scripts/deploy.sh) ends with Scout stopping, so its unit has to start it again: Restart=always.
 * It also waits on the deploy lock before it starts: an `ExecStartPre` running `flock <install dir>/.deploy.lock`.
 * `shown` is `systemctl show <unit> -p LoadState -p Restart -p ExecStartPre`; a unit systemd doesn't know is no check at all.
 */
export function checkRestarts(unit: Unit, shown: string, installDir: string = process.cwd()): Check | undefined {
	const props = Object.fromEntries(shown.split("\n").map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]));
	if (props.LoadState !== "loaded") return undefined;
	const name = "Restarts";
	const reload = `systemctl${unit.user ? " --user" : ""} daemon-reload`;
	if (props.Restart !== "always") {
		return {
			name,
			status: "warn",
			detail: `the ${unit.name} unit has Restart=${props.Restart ?? "?"}, so a drain for a deploy leaves Scout stopped`,
			fix: `Set Restart=always as deploy/scout.service does, then ${reload} (docs/operations.md#deploying).`,
		};
	}
	// What scripts/deploy.sh looks for before it drains: the unit waits on the lock the deploy holds.
	const lock = join(installDir, ".deploy.lock");
	if (!(props.ExecStartPre ?? "").includes(`flock ${lock} `)) {
		return {
			name,
			status: "warn",
			detail: `the ${unit.name} unit doesn't wait for the deploy lock, so systemd could start Scout on half-updated code`,
			fix: `Add these under [Service], then ${reload} (deploy/scout.service, docs/operations.md#deploying):\n    ExecStartPre=/usr/bin/flock ${lock} true\n    TimeoutStartSec=15min`,
		};
	}
	return { name, status: "ok", detail: `the ${unit.name} unit restarts Scout whenever it stops, and waits for the deploy lock` };
}

/** The restart check for `unit`, or nothing when there's no unit or no systemd to ask. */
export async function restartsOf(unit: Unit | undefined, show: (args: string[]) => Promise<string> = systemctl): Promise<Check | undefined> {
	if (unit === undefined) return undefined;
	const shown = await show([...(unit.user ? ["--user"] : []), "show", unit.name, "-p", "LoadState", "-p", "Restart", "-p", "ExecStartPre"]).catch(() => undefined);
	return shown === undefined ? undefined : checkRestarts(unit, shown);
}

async function systemctl(args: string[]): Promise<string> {
	return (await run("systemctl", args, { timeout: 10_000 })).stdout;
}

/** Everything, in order; `mcp` connects the configured servers and returns how many tools they offer. */
export async function doctor(
	config: Config,
	deps: {
		fetch?: typeof fetch;
		git?: (args: string[]) => Promise<string>;
		mcp?: () => Promise<number>;
		directory?: () => Promise<string>;
		/** The models Scout talks to; with them the doctor asks the configured model for one short answer. */
		models?: Models;
		/** What the running Scout says about itself; an error when it can't be asked. */
		running?: () => Promise<Running>;
		/** The service's restart policy (restartsOf); nothing when Scout doesn't run under systemd. */
		restarts?: () => Promise<Check | undefined>;
	} = {},
): Promise<Check[]> {
	const doFetch = deps.fetch ?? fetch;
	const checks: Check[] = [
		{ name: "Settings", status: "ok", detail: `${config.repos.length} repositor${config.repos.length === 1 ? "y" : "ies"}, model ${config.model.provider}/${config.model.modelId}` },
		await checkSlack(config.slack.botToken, doFetch),
		await checkCodeHost(config.codeHost, doFetch),
		await checkRequesters(config, doFetch),
	];
	if (config.sandbox.driver === "spoond" && config.sandbox.spoond !== undefined) checks.push(await checkSpoond(config.sandbox.spoond.url, config.sandbox.spoond.token, doFetch));
	else checks.push({ name: "Sandboxes", status: "ok", detail: `${config.sandbox.driver} driver` });
	if (config.gateway !== undefined) checks.push(await checkGateway(config.gateway, config.gateway.models ?? [], doFetch));
	if (deps.models !== undefined) checks.push(await checkModel(deps.models, config.model));
	for (const repo of config.repos) checks.push(await checkGitRemote(`Repository ${repo.name}`, repo.gitUrl, repo.base, deps.git));
	if (config.profileRepo !== undefined) {
		checks.push(await checkGitRemote("Profile repository", config.profileRepo.gitUrl, config.profileRepo.base, deps.git));
		checks.push(checkProfileDir(config.profileDir, config.profileRepo.gitUrl));
	}
	if (config.governance.directory !== undefined && deps.directory !== undefined) checks.push(await checkDirectory(deps.directory));
	if (config.mcpFile !== undefined && deps.mcp !== undefined) {
		try {
			const tools = await deps.mcp();
			checks.push({ name: "MCP servers", status: "ok", detail: `${tools} tools` });
		} catch (error) {
			checks.push({ name: "MCP servers", status: "fail", detail: firstLine(error), fix: `Check ${config.mcpFile}, and that each server starts on its own.` });
		}
	}
	checks.push(checkDashboard(config.dash));
	const running = deps.running === undefined ? undefined : await deps.running().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
	// The running Scout knows its data directory for sure (a unit can set it outside .env); otherwise, this one's.
	checks.push(checkBackups(running === undefined || running instanceof Error || running.backup === undefined ? backupState(config.dataDir, config.backup) : running.backup));
	const restarts = await deps.restarts?.();
	if (restarts !== undefined) checks.push(restarts);
	if (running !== undefined) checks.push(...checkRunning(running));
	return checks;
}

/** The doctor can't ask the running Scout as configured (no dashboard, or no token for it): a warning, not Scout down. */
export class CantAsk extends Error {}

/** What a running Scout reports about itself: the dashboard's snapshot (dash/collect.ts), or the part of it these checks read. */
export type Running = Pick<Snapshot, "now" | "startedAt" | "alerts" | "working" | "capacity" | "backup">;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Is the running Scout keeping up? Fails only on what needs a person now: Scout not answering, or a problem that has
 * lasted an hour. Slowness is a warning, with where it comes from. So a scheduled `npm run doctor` is a monitor.
 */
export function checkRunning(running: Running | Error): Check[] {
	if (running instanceof CantAsk) return [{ name: "Running", status: "warn", detail: `can't ask the running Scout: ${running.message}`, fix: "See docs/operations.md, Monitoring." }];
	if (running instanceof Error) {
		return [{ name: "Running", status: "fail", detail: `Scout isn't answering: ${firstLine(running)}`, fix: "Before the first start, that's expected. Otherwise: is the service running? Check its status and its log (systemctl status scout; journalctl -u scout)." }];
	}
	const { now, capacity } = running;
	const checks: Check[] = [
		{
			name: "Running",
			status: "ok",
			detail: `up ${duration(now - running.startedAt)}, ${running.working.length} working${capacity === undefined || capacity.queued === 0 ? "" : `, ${capacity.queued} waiting their turn`}`,
		},
	];
	for (const p of running.alerts) {
		const lasted = now - p.since;
		checks.push({ name: "Problem", status: lasted >= HOUR ? "fail" : "warn", detail: `${p.message} (for ${duration(lasted)})`, fix: "The dashboard and Scout's log have the details." });
	}
	for (const w of running.working) {
		if (now - w.startedAt < 2 * HOUR) continue;
		checks.push({
			name: "Long run",
			status: "warn",
			detail: `a thread in #${w.channel} has been working for ${duration(now - w.startedAt)} (${w.steps} steps${w.lastStep === undefined ? "" : `, last: ${w.lastStep}`})`,
			fix: "Look at the thread: Scout says there what it's waiting on, and 🛑 stops it.",
		});
	}
	if (capacity !== undefined) {
		const runs = capacity.waits.find((w) => w.kind === "run");
		if (runs !== undefined && runs.count > 0 && runs.p90 >= 15 * MINUTE) {
			checks.push({ name: "Waiting", status: "warn", detail: `requests waited up to ${duration(runs.p90)} for their turn in the last day (90th percentile)`, fix: "Raise the run limits (SCOUT_MAX_RUNS) if the sandbox host and model allow it; see docs/operations.md, Capacity." });
		}
		const first = capacity.firstToken;
		if (first !== undefined && first.count >= 20 && first.p90 >= 30_000) {
			checks.push({ name: "Model", status: "warn", detail: `slow to start answering: half of ${first.count} calls in the last day waited over ${duration(first.p50)}, the slowest tenth over ${duration(first.p90)}`, fix: "That's the model gateway or its provider, not Scout: check the gateway's queue and the provider's status, or try a model that starts sooner." });
		}
		if (capacity.sandboxWaiting > 0) {
			checks.push({ name: "Sandboxes", status: "warn", detail: `${capacity.sandboxWaiting} waiting for room on the sandbox host`, fix: "The sandbox host is full: free room on it, or lower Scout's run limits." });
		}
		if (capacity.loopLag.p99 >= 1000) {
			checks.push({ name: "Event loop", status: "warn", detail: `lagging ${Math.round(capacity.loopLag.p99)} ms (99th percentile over the last minute)`, fix: "Scout's process is overloaded: fewer runs at once, or look for a busy loop in the log." });
		}
	}
	return checks;
}

function duration(ms: number): string {
	const m = Math.round(ms / MINUTE);
	if (ms < MINUTE) return `${Math.round(ms / 1000)}s`;
	return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 === 0 ? "" : String(m % 60).padStart(2, "0")}`;
}

/** The running Scout's snapshot from its dashboard (`/status.json`), with the metrics token. */
export async function fetchRunning(dash: Config["dash"], token: string | undefined, doFetch: typeof fetch = fetch): Promise<Running> {
	if (dash === undefined) throw new CantAsk("its dashboard is off (SCOUT_DASH_ADDR), so there's nothing to ask");
	if (token === undefined && dash.auth !== undefined) throw new CantAsk("set SCOUT_METRICS_TOKEN, so the doctor and monitors can read /status.json behind the dashboard's login");
	const response = await doFetch(`${dashboardUrl(dash.addr)}/status.json`, {
		headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error(`its dashboard answered ${response.status}`);
	return (await response.json()) as Running;
}

/** The dashboard as this host reaches it: one listening on every address answers on loopback. */
export function dashboardUrl(addr: string): string {
	const { host, port } = /^(?<host>.*):(?<port>\d+)$/.exec(addr)?.groups ?? { host: "127.0.0.1", port: "8893" };
	const reach = host === "0.0.0.0" || host === "" || host === "::" || host === "[::]" ? "127.0.0.1" : host;
	return `http://${reach}:${port}`;
}

async function gitOut(args: string[]): Promise<string> {
	const { stdout } = await run("git", args, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 30_000 });
	return stdout;
}

/** What the remote said that matters: stderr minus the boilerplate after it ("Please make sure you have the correct access rights…"). */
function gitReason(error: unknown): string {
	const stderr = (error as { stderr?: unknown }).stderr;
	const text = typeof stderr === "string" && stderr.trim() !== "" ? stderr : error instanceof Error ? error.message : String(error);
	const lines = text
		.split("\n")
		.map((l) => l.replace(/^(fatal|ssh|error): /, "").trim())
		.filter((l) => l !== "" && !/^Command failed|^Could not read from remote|^Please make sure|^and the repository exists|^Warning: Permanently added/.test(l));
	return (lines.length === 0 ? firstLine(error) : lines.join("; ")).slice(0, 300);
}

function gitHint(why: string): string {
	if (/host key verification/i.test(why)) return "Trust the code host's SSH host key as Scout's user: ssh-keyscan <code host> >> ~/.ssh/known_hosts (docs/setup.md, step 3).";
	if (/permission denied|publickey/i.test(why)) return "Scout's SSH key isn't accepted: add its public key to Scout's code host account, and check SCOUT_GIT_SSH_KEY names that key (docs/setup.md, step 3).";
	if (/could not resolve|name or service|connection (refused|timed out)|timed out|no route/i.test(why)) return "Check the host in the URL, and that this machine can reach it (and the SSH port).";
	if (/not found|does not exist|not appear to be a git repository/i.test(why)) return "Check the URL, and that Scout's account has access to the repository.";
	return "Check the URL and that Scout's SSH key (SCOUT_GIT_SSH_KEY) is on its code host account.";
}

/** Why a request never got an answer, from what Node says under "fetch failed" (`error.cause.code`), and what to look at. */
export function reachHint(error: Error, url: string): string | undefined {
	const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
	const code = typeof cause?.code === "string" ? cause.code : "";
	const said = `${code} ${typeof cause?.message === "string" ? cause.message : ""} ${error.name}`;
	if (code === "ECONNREFUSED") return "Nothing is listening at that host and port: check the URL, port included, and that the server is running.";
	if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "That host name doesn't resolve: check its spelling in the URL, and this machine's DNS.";
	if (code === "ECONNRESET" || code === "EPROTO" || /wrong version number|packet length|ssl|tls/i.test(said)) {
		return url.startsWith("https:")
			? "Often https against a server that serves plain http: try http:// in the URL, or check the port."
			: "Often http against a server that needs https: try https:// in the URL, or check the port.";
	}
	if (/CERT|SELF_SIGNED|ISSUER/.test(code)) return "This machine doesn't trust the server's certificate: use one from a known authority, or have Node trust yours (NODE_EXTRA_CA_CERTS).";
	if (/TIMEOUT|TimeoutError|abort/i.test(said)) return "The server didn't answer in time: check the URL, and that a firewall isn't dropping the connection.";
	return undefined;
}

function hint(error: Error, url: string): { fix?: string } {
	const fix = reachHint(error, url);
	return fix === undefined ? {} : { fix };
}

function firstLine(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 200);
}

/** Connect the configured MCP servers, count their tools, and let go; any that don't connect is the error. */
export async function countMcpTools(path: string): Promise<number> {
	const { loadMcpConfig, connectMcp, closeMcp } = await import("./mcp.ts");
	const config = loadMcpConfig(path);
	const connections = await connectMcp(config);
	try {
		const missing = Object.keys(config.servers).filter((name) => !connections.some((c) => c.name === name));
		if (missing.length > 0) throw new Error(`couldn't connect ${missing.join(", ")}`);
		let tools = 0;
		for (const c of connections) tools += (await c.client.listTools()).tools.length;
		return tools;
	} finally {
		await closeMcp(connections);
	}
}
