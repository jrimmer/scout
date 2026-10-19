import { resolve } from "node:path";

export type CodeHostKind = "forgejo" | "github";

export type Config = {
	slack: { botToken: string; appToken: string };
	/** `provider/modelId`, e.g. `anthropic/claude-opus-5-5`. */
	model: { provider: string; modelId: string };
	dataDir: string;
	profileDir: string;
	repo: {
		/** Clone/push URL the host can reach with its own credentials. The sandbox never gets them. */
		gitUrl: string;
		base: string;
		/** `owner/name` on the code host. */
		slug: string;
	};
	codeHost: { kind: CodeHostKind; apiUrl: string; token: string };
	/**
	 * The repository `profileDir` is a clone of. With it, Scout keeps its profile pulled and proposes changes to it
	 * every night from what happened in its threads. Without it, the profile is just a local directory.
	 */
	profileRepo?: { gitUrl: string; base: string; slug: string };
	/** Local hour (0-23) for the nightly reflection, and a public channel to announce its proposals in. */
	reflect: { hour: number; channel?: string };
	sandbox: { image: string; network: string; memory: string };
	git: { name: string; email: string };
};

function required(env: NodeJS.ProcessEnv, name: string): string {
	const value = env[name];
	if (value === undefined || value === "") throw new Error(`${name} is not set (see .env.example)`);
	return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
	const [provider, ...rest] = (env.SCOUT_MODEL ?? "anthropic/claude-opus-5-5").split("/");
	const modelId = rest.join("/");
	if (provider === undefined || modelId === "") throw new Error("SCOUT_MODEL must look like provider/modelId");

	const kind = env.SCOUT_CODEHOST ?? "forgejo";
	if (kind !== "forgejo" && kind !== "github") throw new Error("SCOUT_CODEHOST must be forgejo or github");

	return {
		slack: { botToken: required(env, "SLACK_BOT_TOKEN"), appToken: required(env, "SLACK_APP_TOKEN") },
		model: { provider, modelId },
		dataDir: resolve(env.SCOUT_DATA_DIR ?? "data"),
		profileDir: resolve(env.SCOUT_PROFILE_DIR ?? "profile"),
		repo: {
			gitUrl: required(env, "SCOUT_REPO_URL"),
			base: env.SCOUT_REPO_BASE ?? "main",
			slug: required(env, "SCOUT_REPO_SLUG"),
		},
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
		sandbox: {
			image: env.SCOUT_SANDBOX_IMAGE ?? "scout-sandbox:latest",
			network: env.SCOUT_SANDBOX_NETWORK ?? "none",
			memory: env.SCOUT_SANDBOX_MEMORY ?? "4g",
		},
		git: { name: env.SCOUT_GIT_NAME ?? "Scout", email: env.SCOUT_GIT_EMAIL ?? "scout@localhost" },
	};
}
