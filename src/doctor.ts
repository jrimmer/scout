import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { promisify } from "node:util";
import { NEEDS } from "./capabilities.ts";
import type { CodeHost } from "./codehost.ts";
import type { Config } from "./config.ts";
import { parseAutheliaUsers } from "./directory.ts";
import type { GatewayConfig } from "./gateway.ts";
import type { Snapshot } from "./dash/collect.ts";

const run = promisify(execFile);

/**
 * Is everything Scout depends on reachable and set up right? One check per integration, each with how to fix what
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
	if (user instanceof Error) return { name, status: "fail", detail: `can't reach ${host.apiUrl} (${user.message})` };
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

export async function checkSpoond(url: string, token: string, doFetch: typeof fetch = fetch): Promise<Check> {
	const name = "spoond";
	const response = await doFetch(`${url.replace(/\/$/, "")}/api/users/me`, { headers: { authorization: `Bearer ${token}` } }).catch((error: unknown) => error as Error);
	if (response instanceof Error) return { name, status: "fail", detail: `can't reach ${url} (${response.message})` };
	if (!response.ok) return { name, status: "fail", detail: `the token was refused (${response.status})`, fix: "Check SCOUT_SPOOND_TOKEN (or the file it names)." };
	const me = (await response.json().catch(() => ({}))) as { share?: { name?: string }; user?: { name?: string } };
	return { name, status: "ok", detail: `signed in as ${me.share?.name ?? me.user?.name ?? "?"}` };
}

export async function checkGateway(gateway: GatewayConfig, wanted: readonly string[], doFetch: typeof fetch = fetch): Promise<Check> {
	const name = "Model gateway";
	const response = await doFetch(`${gateway.url}/models`, {
		headers: { ...(gateway.key === undefined ? {} : { authorization: `Bearer ${gateway.key}` }), ...gateway.headers },
	}).catch((error: unknown) => error as Error);
	if (response instanceof Error) return { name, status: "fail", detail: `can't reach ${gateway.url} (${response.message})` };
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
		return { name, status: "fail", detail: `can't reach ${gitUrl} (${firstLine(error)})`, fix: "Check the URL and that Scout's SSH key (SCOUT_GIT_SSH_KEY) is on its code host account." };
	}
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

/** Everything, in order; `mcp` connects the configured servers and returns how many tools they offer. */
export async function doctor(
	config: Config,
	deps: {
		fetch?: typeof fetch;
		git?: (args: string[]) => Promise<string>;
		mcp?: () => Promise<number>;
		directory?: () => Promise<string>;
		/** What the running Scout says about itself; an error when it can't be asked. */
		running?: () => Promise<Running>;
	} = {},
): Promise<Check[]> {
	const doFetch = deps.fetch ?? fetch;
	const checks: Check[] = [
		{ name: "Settings", status: "ok", detail: `${config.repos.length} repositor${config.repos.length === 1 ? "y" : "ies"}, model ${config.model.provider}/${config.model.modelId}` },
		await checkSlack(config.slack.botToken, doFetch),
		await checkCodeHost(config.codeHost, doFetch),
	];
	if (config.sandbox.driver === "spoond" && config.sandbox.spoond !== undefined) checks.push(await checkSpoond(config.sandbox.spoond.url, config.sandbox.spoond.token, doFetch));
	else checks.push({ name: "Sandboxes", status: "ok", detail: `${config.sandbox.driver} driver` });
	if (config.gateway !== undefined) checks.push(await checkGateway(config.gateway, config.gateway.models ?? [], doFetch));
	for (const repo of config.repos) checks.push(await checkGitRemote(`Repository ${repo.name}`, repo.gitUrl, repo.base, deps.git));
	if (config.profileRepo !== undefined) checks.push(await checkGitRemote("Profile repository", config.profileRepo.gitUrl, config.profileRepo.base, deps.git));
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
	if (deps.running !== undefined) checks.push(...checkRunning(await deps.running().catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))));
	return checks;
}

/** What a running Scout reports about itself: the dashboard's snapshot (dash/collect.ts), or the part of it these checks read. */
export type Running = Pick<Snapshot, "now" | "startedAt" | "alerts" | "working" | "capacity">;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Is the running Scout keeping up? Fails only on what needs a person now: Scout not answering, or a problem that has
 * lasted an hour. Slowness is a warning, with where it comes from. So a scheduled `npm run doctor` is a monitor.
 */
export function checkRunning(running: Running | Error): Check[] {
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
	if (dash === undefined) throw new Error("its dashboard is off (SCOUT_DASH_ADDR), so there's nothing to ask");
	if (token === undefined && dash.auth !== undefined) throw new Error("set SCOUT_METRICS_TOKEN, so the doctor and monitors can read /status.json behind the dashboard's login");
	const { host, port } = /^(?<host>.*):(?<port>\d+)$/.exec(dash.addr)?.groups ?? { host: "127.0.0.1", port: "8893" };
	const reach = host === "0.0.0.0" || host === "" || host === "::" || host === "[::]" ? "127.0.0.1" : host;
	const response = await doFetch(`http://${reach}:${port}/status.json`, {
		headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
		signal: AbortSignal.timeout(10_000),
	});
	if (!response.ok) throw new Error(`its dashboard answered ${response.status}`);
	return (await response.json()) as Running;
}

async function gitOut(args: string[]): Promise<string> {
	const { stdout } = await run("git", args, { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 30_000 });
	return stdout;
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
