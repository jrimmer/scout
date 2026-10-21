import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
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
	/** How long a closed (not merged) pull request of Scout's keeps its branch, so it can be reopened. */
	closedBranchDays: number;
	/** Remind reviewers of pull requests waiting on them this many days, once a working day per channel; 0 never. */
	reviewNudgeDays: number;
	/** Largest change, in lines added plus removed, Scout puts in one pull request. */
	maxPullLines: number;
	/** Scout's commit identity, and the SSH key the host pushes and pulls with: Scout's own, not a person's. */
	git: { name: string; email: string; sshKey?: string };
};

/** `gateway/…` models: SCOUT_GATEWAY_MODELS (comma-separated), and SCOUT_MODEL's when it is one. */
function gatewayModels(env: NodeJS.ProcessEnv, model: string | undefined): string[] {
	const listed = (env.SCOUT_GATEWAY_MODELS ?? "").split(",").map((m) => m.trim()).filter(Boolean);
	return [...new Set(model === undefined ? listed : [model, ...listed])];
}

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (value === undefined || value === "") throw new Error(`${name} is not set (see .env.example)`);
	return value;
}

/** More repositories, from a JSON file: `[{ "name", "gitUrl", "slug", "base"?, "image"?, "snapshot"?, "egress"? }]`. */
function moreRepos(path: string | undefined): RepoConfig[] {
	if (path === undefined || path === "") return [];
	const list = JSON.parse(readFileSync(path, "utf8")) as Partial<RepoConfig>[];
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
			hour: Number(env.SCOUT_REFLECT_HOUR ?? 3),
			// A name, with or without `#` (in an env file an unquoted `#` starts a comment, so `scout` is the safe spelling).
			...(env.SCOUT_REFLECT_CHANNEL?.replace(/^#/, "") ? { channel: env.SCOUT_REFLECT_CHANNEL.replace(/^#/, "") } : {}),
		},
		maxPullLines: Number(env.SCOUT_PR_MAX_LINES ?? 1000),
		pullUpkeep: {
			staleDays: Number(env.SCOUT_PR_STALE_DAYS ?? 14),
			// Half as long again, unless set.
			closeDays: Number(env.SCOUT_PR_CLOSE_DAYS ?? Number(env.SCOUT_PR_STALE_DAYS ?? 14) / 2),
		},
		weeklySummary: env.SCOUT_WEEKLY_SUMMARY !== "off",
		reviewNudgeDays: Number(env.SCOUT_REVIEW_NUDGE_DAYS ?? 3),
		closedBranchDays: Number(env.SCOUT_CLOSED_BRANCH_DAYS ?? 30),
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
							...(env.SCOUT_OTLP_HEADERS ? { headers: JSON.parse(env.SCOUT_OTLP_HEADERS) as Record<string, string> } : {}),
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
						...(env.SCOUT_GATEWAY_HEADERS ? { headers: JSON.parse(env.SCOUT_GATEWAY_HEADERS) as Record<string, string> } : {}),
						...(env.SCOUT_GATEWAY_OPENAI_API === "responses" ? { openaiApi: "responses" as const } : {}),
						models: gatewayModels(env, provider === "gateway" ? modelId : undefined),
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
