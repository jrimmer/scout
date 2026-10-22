import { existsSync, readFileSync } from "node:fs";
import { type Initiative, parseInitiative } from "./initiative.ts";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { GatewayConfig } from "./gateway.ts";

export type CodeHostKind = "forgejo" | "github";

/** A repository Scout works in. `name` is what channel profiles refer to it by. */
export type RepoConfig = {
	name: string;
	/** Clone/push URL the host can reach with its own credentials. The sandbox never gets them. */
	gitUrl: string;
	base: string;
	/** `owner/name` on the code host. */
	slug: string;
	/** The sandbox image for this repository's threads, if it needs its own toolchain; else SCOUT_SANDBOX_IMAGE. */
	image?: string;
	/** spoond: a named snapshot its threads start from (toolchain installed, caches warm), instead of `image`. */
	snapshot?: string;
	/** Hosts this repository's sandboxes may reach, on substrates with an egress firewall (spoond). */
	egress?: string[];
	/** Its sandboxes' size, if its builds need more than SCOUT_SANDBOX_SIZE gives (spoond: small to xlarge). */
	size?: string;
};

export type SandboxConfig = {
	/** Where sandboxes run: `docker` on this host, `spoond` microVMs, or `local` (no isolation; tests and laptops). */
	driver: "docker" | "spoond" | "local";
	image: string;
	/** `none`, or `open` for the internet. Repositories with an egress list get just that, where the driver can. */
	network: "none" | "open";
	/** Docker: a memory limit like `4g`. spoond: `small`, `medium`, `large` or `xlarge`. */
	size?: string;
	/** Docker's network for `open`. */
	dockerNetwork: string;
	/** `transport`: the pi-env daemon over spoond's stream WebSocket, or spoond's REST API with no connection held. */
	spoond?: { url: string; token: string; transport: "stream" | "rest" };
};

export type Config = {
	slack: { botToken: string; appToken: string };
	/** `provider/modelId`, e.g. `anthropic/claude-opus-5-5`. */
	model: { provider: string; modelId: string };
	dataDir: string;
	/** Pi Durable from main may convert this data dir's pi.sqlite, which its release can't open afterwards. */
	piMigrate: boolean;
	profileDir: string;
	/** The default repository: threads in channels whose profile names no other work here. */
	repo: RepoConfig;
	/** Every repository, the default first. */
	repos: RepoConfig[];
	codeHost: { kind: CodeHostKind; apiUrl: string; token: string };
	/**
	 * The repository `profileDir` is a clone of. With it, Scout keeps its profile pulled and proposes changes to it
	 * every night from what happened in its threads. Without it, the profile is just a local directory.
	 */
	profileRepo?: { gitUrl: string; base: string; slug: string };
	/** Local hour (0-23) for the nightly reflection, and Scout's home channel: proposals and the weekly report. */
	reflect: { hour: number; channel?: string };
	/**
	 * The nightly benchmark (bench.ts), off unless SCOUT_BENCH_MODELS names models: each night after `hour`, every
	 * model runs the tasks in `tasksDir` once.
	 */
	bench?: { models: { provider: string; modelId: string }[]; hour: number; tasksDir: string };
	/** Monitoring Scout watches for alerts to investigate (alerts.ts); none set, it watches none. */
	alerts: { gatusUrl?: string; grafana?: { url: string; token: string }; channel?: string };
	sandbox: SandboxConfig;
	/** Governance (see pricing.ts, limits.ts, permissions.ts, retention.ts, telemetry.ts). All optional. */
	governance: {
		/** Local model prices, dollars per million tokens. */
		pricesFile?: string;
		/** Budgets, per-run limits and concurrency. */
		limitsFile?: string;
		/** `enforce`: only people who can change a repository may ask for work in it. */
		requesterCheck: "off" | "enforce";
		/** Slack user ID → code host login, for the requester check. */
		peopleFile?: string;
		/** Only this Slack user group may ask for work. */
		allowedUserGroup?: string;
		/** The identity provider (directory.ts): who people are and their groups, by email. */
		directory?: { kind: "authelia-file"; source: string };
		/** Who may approve changes made through tools, by group (directory.ts `Roles`). */
		rolesFile?: string;
		/** Delete what quiet threads leave behind after this many days. */
		retentionDays?: number;
		/** OTLP/HTTP traces endpoint (…/v1/traces), and headers for it. */
		otlp?: { endpoint: string; headers?: Record<string, string> };
		/** Bearer token for /metrics on the dashboard listener; without it, /metrics uses the dashboard's login. */
		metricsToken?: string;
	};
	/** Model calls through a gateway (see gateway.ts), when SCOUT_GATEWAY_URL is set. */
	gateway?: GatewayConfig;
	/** The read-only dashboard (see dash/server.ts); absent when SCOUT_DASH_ADDR is `off`. */
	dash?: { addr: string; auth?: { user: string; passwordHash: string } };
	/** MCP servers whose tools Scout may use (see mcp.ts). */
	mcpFile?: string;
	/**
	 * Looking after Scout's own pull requests (upkeep.ts): after `staleDays` quiet, ask whoever wanted one if it's still
	 * wanted; `closeDays` later, still quiet, close it. 0 days leaves them alone.
	 */
	pullUpkeep: { staleDays: number; closeDays: number };
	/** Each channel's weekly summary, Mondays (weekly.ts). */
	weeklySummary: boolean;
	/**
	 * How much runs at once (capacity.ts): runs in all and per channel (unless the limits file says), model calls in
	 * flight (0: no limit), how long a new sandbox may wait for room on a full sandbox host, and how long a drain for a
	 * restart waits for the steps running to finish (drain.ts), in seconds.
	 */
	capacity: { maxRuns: number; maxRunsPerChannel: number; maxModelCalls: number; sandboxPatience: number; drainMax: number };
	/** Whether a request's reaction follows what Scout is doing (🧠, 📖, 🧪…), or only 👀 then ✅ (reactions.ts). */
	statusReactions: boolean;
	/** How much Scout does on its own initiative (initiative.ts): asked, own or team. */
	initiative: Initiative;
	/** The repos file (SCOUT_REPOS_FILE), where an egress host people allow is saved (egress.ts). */
	reposFile?: string;
	/** Searching and reading every configured repository's code from any thread (codesearch.ts). */
	codeSearch: boolean;
	/** Experimental: trying several approaches at once when someone asks (approaches.ts). */
	parallel: boolean;
	/** Follow up on a thread waiting on people this many days (recaps.ts); 0 never. */
	threadRecapDays: number;
	/** How long a closed (not merged) pull request of Scout's keeps its branch, so it can be reopened. */
	closedBranchDays: number;
	/** Remind reviewers of pull requests waiting on them this many days, once a working day per channel; 0 never. */
	reviewNudgeDays: number;
	/** Largest change, in lines added plus removed, Scout puts in one pull request. */
	maxPullLines: number;
	/** Scout's commit identity, and the SSH key the host pushes and pulls with: Scout's own, not a person's. */
	git: { name: string; email: string; sshKey?: string };
};

/** `gateway/…` models: SCOUT_GATEWAY_MODELS (comma-separated), SCOUT_MODEL's when it is one, and the benchmark's. */
function gatewayModels(env: NodeJS.ProcessEnv, model: string | undefined, bench: readonly { provider: string; modelId: string }[]): string[] {
	const listed = (env.SCOUT_GATEWAY_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);
	const benched = bench.filter((m) => m.provider === "gateway").map((m) => m.modelId);
	return [...new Set([...(model === undefined ? [] : [model]), ...listed, ...benched])];
}

/** A JSON setting, or a plain message saying what's wrong with it. */
function jsonSetting<T>(env: NodeJS.ProcessEnv, name: string, example: string): T | undefined {
	const raw = env[name];
	if (raw === undefined || raw === "") return undefined;
	try {
		return JSON.parse(raw) as T;
	} catch (error) {
		throw new Error(`${name} isn't valid JSON (${error instanceof Error ? error.message : String(error)}); it should look like ${example}`);
	}
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (value === undefined || value === "") throw new Error(`${name} is not set (see .env.example)`);
	return value;
}

/** More repositories, from a JSON file: `[{ "name", "gitUrl", "slug", "base"?, "image"?, "snapshot"?, "egress"?, "size"? }]`. */
function moreRepos(path: string | undefined): RepoConfig[] {
	if (path === undefined || path === "") return [];
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new Error(`SCOUT_REPOS_FILE: can't read ${path} (${(error as { code?: string }).code ?? String(error)})`);
	}
	let list: Partial<RepoConfig>[];
	try {
		list = JSON.parse(text) as Partial<RepoConfig>[];
	} catch (error) {
		throw new Error(`SCOUT_REPOS_FILE: ${path} isn't valid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	if (!Array.isArray(list)) throw new Error(`SCOUT_REPOS_FILE: ${path} should be a list of repositories, [{ "name", "gitUrl", "slug" }, …]`);
	return list.map((r, i) => {
		if (!r.name || !r.gitUrl || !r.slug) throw new Error(`${path}: repository ${i + 1} needs name, gitUrl and slug`);
		return {
			name: r.name,
			gitUrl: r.gitUrl,
			slug: r.slug,
			base: r.base ?? "main",
			...(r.image ? { image: r.image } : {}),
			...(r.snapshot ? { snapshot: r.snapshot } : {}),
			...(Array.isArray(r.egress) ? { egress: r.egress } : {}),
			...(typeof r.size === "string" && r.size !== "" ? { size: r.size } : {}),
		};
	});
}

function sandboxConfig(env: NodeJS.ProcessEnv): SandboxConfig {
	const driver = env.SCOUT_SANDBOX_DRIVER ?? "docker";
	if (driver !== "docker" && driver !== "spoond" && driver !== "local") {
		throw new Error("SCOUT_SANDBOX_DRIVER must be docker, spoond or local");
	}
	const network = env.SCOUT_SANDBOX_NETWORK ?? "none";
	if (network !== "none" && network !== "open") throw new Error("SCOUT_SANDBOX_NETWORK must be none or open");
	const size = env.SCOUT_SANDBOX_SIZE ?? (driver === "docker" ? "4g" : undefined);
	const transport = env.SCOUT_SPOOND_TRANSPORT ?? "stream";
	if (transport !== "stream" && transport !== "rest") throw new Error("SCOUT_SPOOND_TRANSPORT must be stream or rest");
	return {
		driver,
		image: env.SCOUT_SANDBOX_IMAGE ?? (driver === "spoond" ? "dev-base" : "scout-sandbox:latest"),
		network,
		...(size === undefined ? {} : { size }),
		dockerNetwork: env.SCOUT_DOCKER_NETWORK ?? "bridge",
		...(driver === "spoond" ? { spoond: { url: required(env, "SCOUT_SPOOND_URL"), token: required(env, "SCOUT_SPOOND_TOKEN"), transport } } : {}),
	};
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const slug = required(env, "SCOUT_REPO_SLUG");
	if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) throw new Error(`SCOUT_REPO_SLUG should look like owner/name, not "${slug}"`);
	const repo: RepoConfig = {
		name: env.SCOUT_REPO_NAME ?? slug.split("/").pop() ?? slug,
		gitUrl: required(env, "SCOUT_REPO_URL"),
		base: env.SCOUT_REPO_BASE ?? "main",
		slug,
		...(env.SCOUT_REPO_SNAPSHOT ? { snapshot: env.SCOUT_REPO_SNAPSHOT } : {}),
		...(env.SCOUT_REPO_EGRESS ? { egress: env.SCOUT_REPO_EGRESS.split(",").map((h) => h.trim()).filter(Boolean) } : {}),
	};
	const [provider, ...rest] = (env.SCOUT_MODEL ?? "anthropic/claude-opus-5-5").split("/");
	const modelId = rest.join("/");
	if (provider === undefined || modelId === "") throw new Error("SCOUT_MODEL must look like provider/modelId");

	const kind = env.SCOUT_CODEHOST ?? "forgejo";
	if (kind !== "forgejo" && kind !== "github") throw new Error("SCOUT_CODEHOST must be forgejo or github");
	if (kind === "forgejo" && !env.SCOUT_CODEHOST_API) {
		throw new Error("SCOUT_CODEHOST_API is required for Forgejo: its API address, like https://forgejo.example.com/api/v1");
	}
	const reflectHour = Number(env.SCOUT_REFLECT_HOUR ?? 3);
	if (!Number.isInteger(reflectHour) || reflectHour < 0 || reflectHour > 23) throw new Error(`SCOUT_REFLECT_HOUR should be an hour, 0 to 23, not "${env.SCOUT_REFLECT_HOUR}"`);
	const benchHour = Number(env.SCOUT_BENCH_HOUR ?? 1);
	if (!Number.isInteger(benchHour) || benchHour < 0 || benchHour > 23) throw new Error(`SCOUT_BENCH_HOUR should be an hour, 0 to 23, not "${env.SCOUT_BENCH_HOUR}"`);
	const benchModels = (env.SCOUT_BENCH_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean).map((m) => {
		const [p, ...id] = m.split("/");
		if (p === undefined || id.length === 0) throw new Error(`SCOUT_BENCH_MODELS: "${m}" should look like provider/modelId, as SCOUT_MODEL does`);
		return { provider: p, modelId: id.join("/") };
	});
	if (env.SCOUT_MCP_FILE && !existsSync(resolve(env.SCOUT_MCP_FILE))) throw new Error(`SCOUT_MCP_FILE: there's no file at ${resolve(env.SCOUT_MCP_FILE)}`);

	return {
		// Only the Slack service needs these (see main.ts); jobs run without them.
		slack: { botToken: env.SLACK_BOT_TOKEN ?? "", appToken: env.SLACK_APP_TOKEN ?? "" },
		model: { provider, modelId },
		dataDir: resolve(env.SCOUT_DATA_DIR ?? "data"),
		piMigrate: env.SCOUT_PI_MIGRATE === "1",
		profileDir: resolve(env.SCOUT_PROFILE_DIR ?? "profile"),
		repo,
		repos: [repo, ...moreRepos(env.SCOUT_REPOS_FILE).filter((r) => r.name !== repo.name)],
		codeHost: {
			kind,
			apiUrl: (env.SCOUT_CODEHOST_API ?? (kind === "github" ? "https://api.github.com" : "")).replace(/\/$/, ""),
			token: required(env, "SCOUT_CODEHOST_TOKEN"),
		},
		...(env.SCOUT_PROFILE_REPO_URL
			? {
					profileRepo: {
						gitUrl: env.SCOUT_PROFILE_REPO_URL,
						base: env.SCOUT_PROFILE_REPO_BASE ?? "main",
						slug: required(env, "SCOUT_PROFILE_REPO_SLUG"),
					},
				}
			: {}),
		alerts: {
			// Where alerts no channel claims go, and the first look's list; unset, the home channel.
			...(env.SCOUT_ALERTS_CHANNEL?.replace(/^#/, "") ? { channel: env.SCOUT_ALERTS_CHANNEL.replace(/^#/, "") } : {}),
			...(env.SCOUT_ALERTS_GATUS_URL ? { gatusUrl: env.SCOUT_ALERTS_GATUS_URL.replace(/\/$/, "") } : {}),
			...(env.SCOUT_ALERTS_GRAFANA_URL
				? { grafana: { url: env.SCOUT_ALERTS_GRAFANA_URL.replace(/\/$/, ""), token: required(env, "SCOUT_ALERTS_GRAFANA_TOKEN") } }
				: {}),
		},
		reflect: {
			hour: reflectHour,
			// A name, with or without `#` (in an env file an unquoted `#` starts a comment, so `scout` is the safe spelling).
			...(env.SCOUT_REFLECT_CHANNEL?.replace(/^#/, "") ? { channel: env.SCOUT_REFLECT_CHANNEL.replace(/^#/, "") } : {}),
		},
		...(benchModels.length === 0 ? {} : { bench: { models: benchModels, hour: benchHour, tasksDir: resolve(env.SCOUT_BENCH_TASKS ?? join(import.meta.dirname, "..", "bench")) } }),
		maxPullLines: Number(env.SCOUT_PR_MAX_LINES ?? 1000),
		pullUpkeep: {
			staleDays: Number(env.SCOUT_PR_STALE_DAYS ?? 14),
			// Half as long again, unless set.
			closeDays: Number(env.SCOUT_PR_CLOSE_DAYS ?? Number(env.SCOUT_PR_STALE_DAYS ?? 14) / 2),
		},
		weeklySummary: env.SCOUT_WEEKLY_SUMMARY !== "off",
		initiative: parseInitiative(env.SCOUT_INITIATIVE),
		statusReactions: env.SCOUT_STATUS_REACTIONS !== "off",
		capacity: {
			maxRuns: count(env, "SCOUT_MAX_RUNS", 8, 1),
			maxRunsPerChannel: count(env, "SCOUT_MAX_RUNS_PER_CHANNEL", 3, 1),
			maxModelCalls: count(env, "SCOUT_MAX_MODEL_CALLS", 6, 0),
			sandboxPatience: count(env, "SCOUT_SANDBOX_PATIENCE", 1800, 60),
			drainMax: count(env, "SCOUT_DRAIN_MAX", 600, 0),
		},
		codeSearch: env.SCOUT_CODE_SEARCH !== "off",
		parallel: env.SCOUT_PARALLEL !== "off",
		...(env.SCOUT_REPOS_FILE ? { reposFile: resolve(env.SCOUT_REPOS_FILE) } : {}),
		reviewNudgeDays: Number(env.SCOUT_REVIEW_NUDGE_DAYS ?? 3),
		closedBranchDays: Number(env.SCOUT_CLOSED_BRANCH_DAYS ?? 30),
		threadRecapDays: Number(env.SCOUT_THREAD_RECAP_DAYS ?? 3),
		...(env.SCOUT_MCP_FILE ? { mcpFile: resolve(env.SCOUT_MCP_FILE) } : {}),
		governance: {
			...(env.SCOUT_PRICES_FILE ? { pricesFile: resolve(env.SCOUT_PRICES_FILE) } : {}),
			...(env.SCOUT_DIRECTORY === "authelia-file" ? { directory: { kind: "authelia-file" as const, source: required(env, "SCOUT_DIRECTORY_SOURCE") } } : {}),
			...(env.SCOUT_ROLES_FILE ? { rolesFile: resolve(env.SCOUT_ROLES_FILE) } : {}),
			...(env.SCOUT_LIMITS_FILE ? { limitsFile: resolve(env.SCOUT_LIMITS_FILE) } : {}),
			requesterCheck: env.SCOUT_REQUESTER_CHECK === "enforce" ? "enforce" : "off",
			...(env.SCOUT_PEOPLE_FILE ? { peopleFile: resolve(env.SCOUT_PEOPLE_FILE) } : {}),
			...(env.SCOUT_ALLOWED_USERGROUP ? { allowedUserGroup: env.SCOUT_ALLOWED_USERGROUP } : {}),
			...(env.SCOUT_RETENTION_DAYS ? { retentionDays: Number(env.SCOUT_RETENTION_DAYS) } : {}),
			...(env.SCOUT_OTLP_ENDPOINT
				? {
						otlp: {
							endpoint: env.SCOUT_OTLP_ENDPOINT,
							...(env.SCOUT_OTLP_HEADERS ? { headers: jsonSetting<Record<string, string>>(env, "SCOUT_OTLP_HEADERS", '{"authorization": "Bearer …"}')! } : {}),
						},
					}
				: {}),
			...(env.SCOUT_METRICS_TOKEN ? { metricsToken: env.SCOUT_METRICS_TOKEN } : {}),
		},
		...(env.SCOUT_GATEWAY_URL
			? {
					gateway: {
						url: env.SCOUT_GATEWAY_URL.replace(/\/$/, ""),
						...(env.SCOUT_GATEWAY_KEY ? { key: env.SCOUT_GATEWAY_KEY } : {}),
						...(env.SCOUT_GATEWAY_HEADERS ? { headers: jsonSetting<Record<string, string>>(env, "SCOUT_GATEWAY_HEADERS", '{"x-team": "web"}')! } : {}),
						...(env.SCOUT_GATEWAY_OPENAI_API === "responses" ? { openaiApi: "responses" as const } : {}),
						models: gatewayModels(env, provider === "gateway" ? modelId : undefined, benchModels),
					},
				}
			: {}),
		...(env.SCOUT_DASH_ADDR === "off"
			? {}
			: {
					dash: {
						addr: env.SCOUT_DASH_ADDR ?? "127.0.0.1:8893",
						...(env.SCOUT_DASH_USER && env.SCOUT_DASH_PASSWORD_HASH
							? { auth: { user: env.SCOUT_DASH_USER, passwordHash: env.SCOUT_DASH_PASSWORD_HASH } }
							: {}),
					},
				}),
		sandbox: sandboxConfig(env),
		git: {
			name: env.SCOUT_GIT_NAME ?? "Scout",
			email: env.SCOUT_GIT_EMAIL ?? "scout@localhost",
			...(env.SCOUT_GIT_SSH_KEY ? { sshKey: resolve(env.SCOUT_GIT_SSH_KEY.replace(/^~(?=\/|$)/, homedir())) } : {}),
		},
	};
}

/** Every git command the host runs (clone, fetch, push, profile pulls) uses Scout's own key. Containers never see it. */
export function useScoutsKey(sshKey: string | undefined): void {
	if (sshKey !== undefined) {
		process.env.GIT_SSH_COMMAND = `ssh -i '${sshKey}' -o IdentitiesOnly=yes -o IdentityAgent=none`;
	}
}

/** A whole-number setting, at least `min`, with a plain message when it isn't one. */
function count(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number): number {
	const raw = env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < min) throw new Error(`${name} must be a whole number of at least ${min} (it's "${raw}").`);
	return value;
}
