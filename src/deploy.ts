import { execFileSync } from "node:child_process";
import { type Config, loadConfig } from "./config.ts";
import { dashboardUrl } from "./doctor.ts";
import { resolveSecrets } from "./secrets.ts";

/**
 * What `scripts/deploy.sh` asks of Scout's settings and its code host; the script does the git, npm and systemd parts.
 * With the same settings as the service (.env), as `npm run doctor` reads them.
 *
 * - `check <from> <to> [--pi-backed-up]`: may `to` go out? Only when the code host says CI passed on it, and, when it
 *   moves Pi Durable to another version (which can convert pi.sqlite for good), only once pi.sqlite is backed up.
 * - `restarted <unit> <pid>`: wait until the service has a new main process and its dashboard says it's healthy.
 */
export type CombinedStatus = { total_count?: number; statuses?: { context?: string; state?: string; status?: string }[] | null };
/** A GitHub check run (GitHub Actions report these, not commit statuses). */
export type CheckRun = { name: string; status: string; conclusion: string | null };

/** CI's say on a commit: it passed only when something reported, and everything that reported passed. */
export function ciVerdict(status: CombinedStatus, runs: readonly CheckRun[]): { ok: boolean; say: string } {
	const checks = [
		...(status.statuses ?? []).map((s) => {
			const state = s.status ?? s.state ?? "pending";
			return { name: s.context ?? "check", state: state === "success" ? "passed" : state === "pending" ? "running" : "failed" };
		}),
		...runs.map((r) => ({
			name: r.name,
			state: r.status !== "completed" ? "running" : ["success", "neutral", "skipped"].includes(r.conclusion ?? "") ? "passed" : "failed",
		})),
	];
	const named = (state: string) => checks.filter((c) => c.state === state).map((c) => c.name).join(", ");
	if (checks.length === 0) return { ok: false, say: "nothing has reported CI on it yet" };
	if (named("failed") !== "") return { ok: false, say: `CI failed on it: ${named("failed")}` };
	if (named("running") !== "") return { ok: false, say: `CI is still running on it (${named("running")}); try again once it's done` };
	return { ok: true, say: `CI passed on it (${named("passed")})` };
}

/** How a change moves Pi Durable, "1.4.0 to 1.5.0", or undefined when it stays: from both package.json files. */
export function piMove(before: string, after: string): string | undefined {
	const version = (text: string) => (JSON.parse(text) as { dependencies?: Record<string, string> }).dependencies?.["@earendil-works/pi-durable"];
	const [from, to] = [version(before), version(after)];
	return from === to ? undefined : `${from ?? "nothing"} to ${to ?? "nothing"}`;
}

/** The repository a git remote points at, as owner/name, when it's on the code host whose API is `apiUrl`. */
export function slugOn(remote: string, apiUrl: string): string | undefined {
	const match = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?(?<host>[^/:]+)(?::\d+)?[/:](?<path>.+?)(?:\.git)?\/?$/.exec(remote);
	if (match?.groups === undefined) return undefined;
	if (match.groups.host !== new URL(apiUrl).hostname.replace(/^api\./, "")) return undefined;
	const parts = match.groups.path!.split("/");
	return parts.length < 2 ? undefined : parts.slice(-2).join("/");
}

async function check(config: Config, from: string, to: string, piBackedUp: boolean): Promise<boolean> {
	const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
	let ok = true;
	const pi = piMove(git("show", `${from}:package.json`), git("show", `${to}:package.json`));
	if (pi !== undefined && !piBackedUp) {
		ok = false;
		console.log(
			`It moves Pi Durable from ${pi}, which may convert pi.sqlite for good: nothing older can open it afterwards. ` +
				"Back pi.sqlite up first (`sqlite3 pi.sqlite \".backup pi-before.sqlite\"` in Scout's data directory works while it runs), " +
				"then deploy again with --pi-backed-up.",
		);
	}
	// As configured: an `insteadOf` rewrite is how this host reaches it, not which repository it is.
	const remote = git("config", "--get", "remote.origin.url");
	const slug = slugOn(remote, config.codeHost.apiUrl);
	if (slug === undefined) {
		console.log(`origin (${remote}) isn't on Scout's code host (${config.codeHost.apiUrl}), so I can't ask it whether CI passed.`);
		return false;
	}
	const { kind, apiUrl, token } = config.codeHost;
	const api = async (path: string) => {
		const response = await fetch(`${apiUrl}${path}`, {
			headers: { accept: kind === "github" ? "application/vnd.github+json" : "application/json", authorization: kind === "github" ? `Bearer ${token}` : `token ${token}` },
			signal: AbortSignal.timeout(30_000),
		});
		if (!response.ok) throw new Error(`the code host answered ${response.status} for ${path}`);
		return response.json();
	};
	const status = (await api(`/repos/${slug}/commits/${to}/status`)) as CombinedStatus;
	const runs = kind === "github" ? ((await api(`/repos/${slug}/commits/${to}/check-runs?per_page=100`)) as { check_runs: CheckRun[] }).check_runs : [];
	const verdict = ciVerdict(status, runs);
	console.log(`${slug} at ${to.slice(0, 7)}: ${verdict.say}.`);
	return ok && verdict.ok;
}

async function restarted(config: Config, unit: string, pid: string): Promise<boolean> {
	const started = Date.now();
	const deadline = started + (config.capacity.drainMax + 180) * 1000;
	const seconds = () => Math.round((Date.now() - started) / 1000);
	const mainPid = () => execFileSync("systemctl", ["show", "-p", "MainPID", "--value", unit], { encoding: "utf8" }).trim();
	let said = started;
	while (Date.now() < deadline) {
		const now = mainPid();
		if (now !== pid && now !== "0") {
			if (config.dash === undefined) {
				console.log(`Scout is running again (pid ${now}) after ${seconds()} s. Its dashboard is off (SCOUT_DASH_ADDR), so I couldn't ask whether it's healthy.`);
				return true;
			}
			const answer = await fetch(`${dashboardUrl(config.dash.addr)}/healthz`, { signal: AbortSignal.timeout(5_000) }).then((r) => r.text(), () => "");
			if (answer === "ok") {
				console.log(`Scout is up again on the new code (pid ${now}), ${seconds()} s after the drain began.`);
				return true;
			}
		} else if (Date.now() - said >= 30_000) {
			said = Date.now();
			console.log(`still draining after ${seconds()} s: waiting for the steps running to finish (at most ${config.capacity.drainMax} s)`);
		}
		await new Promise((resolve) => setTimeout(resolve, 2_000));
	}
	console.log(`Scout hasn't come back healthy after ${seconds()} s. Look at \`systemctl status ${unit}\` and \`journalctl -u ${unit}\`.`);
	return false;
}

if (import.meta.main) {
	await resolveSecrets();
	const config = loadConfig();
	const [command, ...args] = process.argv.slice(2);
	let ok: boolean;
	if (command === "check" && args.length >= 2) ok = await check(config, args[0]!, args[1]!, args.includes("--pi-backed-up"));
	else if (command === "restarted" && args.length === 2) ok = await restarted(config, args[0]!, args[1]!);
	else {
		console.error("usage: node src/deploy.ts check <from> <to> [--pi-backed-up] | restarted <unit> <pid>");
		ok = false;
	}
	process.exit(ok ? 0 : 1);
}
