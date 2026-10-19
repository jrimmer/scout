import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

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
};

export type Config = {
	slack: { botToken: string; appToken: string };
	/** `provider/modelId`, e.g. `anthropic/claude-opus-5-5`. */
	model: { provider: string; modelId: string };
	dataDir: string;
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
	sandbox: { image: string; network: string; memory: string };
	/** MCP servers whose tools Scout may use (see mcp.ts). */
	mcpFile?: string;
	/** Pull requests with this label get a review from Scout (automation mode); unset, Scout reviews none. */
	reviewLabel?: string;
	/** Largest change, in lines added plus removed, Scout puts in one pull request. */
	maxPullLines: number;
	/** Scout's commit identity, and the SSH key the host pushes and pulls with: Scout's own, not a person's. */
	git: { name: string; email: string; sshKey?: string };
};

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (value === undefined || value === "") throw new Error(`${name} is not set (see .env.example)`);
	return value;
}

/** More repositories, from a JSON file: `[{ "name", "gitUrl", "slug", "base"?, "image"? }]`. */
function moreRepos(path: string | undefined): RepoConfig[] {
	if (path === undefined || path === "") return [];
	const list = JSON.parse(readFileSync(path, "utf8")) as Partial<RepoConfig>[];
	return list.map((r, i) => {
		if (!r.name || !r.gitUrl || !r.slug) throw new Error(`${path}: repository ${i + 1} needs name, gitUrl and slug`);
		return { name: r.name, gitUrl: r.gitUrl, slug: r.slug, base: r.base ?? "main", ...(r.image ? { image: r.image } : {}) };
	});
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const slug = required(env, "SCOUT_REPO_SLUG");
	const repo: RepoConfig = {
		name: env.SCOUT_REPO_NAME ?? slug.split("/").pop() ?? slug,
		gitUrl: required(env, "SCOUT_REPO_URL"),
		base: env.SCOUT_REPO_BASE ?? "main",
		slug,
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
		reflect: {
			hour: Number(env.SCOUT_REFLECT_HOUR ?? 3),
			...(env.SCOUT_REFLECT_CHANNEL ? { channel: env.SCOUT_REFLECT_CHANNEL } : {}),
		},
		maxPullLines: Number(env.SCOUT_PR_MAX_LINES ?? 1000),
		...(env.SCOUT_REVIEW_LABEL ? { reviewLabel: env.SCOUT_REVIEW_LABEL } : {}),
		...(env.SCOUT_MCP_FILE ? { mcpFile: resolve(env.SCOUT_MCP_FILE) } : {}),
		sandbox: {
			image: env.SCOUT_SANDBOX_IMAGE ?? "scout-sandbox:latest",
			network: env.SCOUT_SANDBOX_NETWORK ?? "none",
			memory: env.SCOUT_SANDBOX_MEMORY ?? "4g",
		},
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
