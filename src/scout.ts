import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { type AgentChange, type ConversationId, createRegistry, Harness, type Storage } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { createCodeHostExtension } from "./codehost.ts";
import type { Config, RepoConfig } from "./config.ts";
import { closeMcp, connectMcp, loadMcpConfig, type McpConnection, mcpExtension } from "./mcp.ts";
import { ThreadDoc } from "./docs.ts";
import { consolidationExtension, Memory, memoryExtension } from "./memory.ts";
import { cloneProfile, loadProfile, type Profile, profileExtension, watchProfile } from "./profile.ts";
import { Pulls } from "./pulls.ts";
import { Reflector, reflectionExtensions } from "./reflect.ts";
import { reviewAsSubtask, reviewEnv, reviewExtension } from "./review.ts";
import { searchExtension, ThreadSearch } from "./search.ts";
import { DockerDriver } from "./drivers/docker.ts";
import { LocalDriver } from "./drivers/local.ts";
import { SpoondDriver } from "./drivers/spoond.ts";
import type { SandboxDriver } from "./drivers/types.ts";
import { Workspaces } from "./workspaces.ts";
import { type ThreadRow, Threads } from "./threads.ts";

/**
 * Everything Scout is, apart from how people reach it: the harness, its extensions, its workspaces and its stores.
 * `main.ts` puts Slack in front of it; `job.ts` runs one task with it and exits.
 */
export type ScoutOptions = {
	config: Config;
	storage: Storage;
	/** Where Scout's own stores and workspaces live. */
	dataDir: string;
	/** Random per install; keeps container, directory and branch names unique. */
	instance: string;
	context: Context;
	/** Where the work in a conversation was discussed, for pull request descriptions. */
	link?: (conversationId: number) => Promise<string | undefined>;
	threadLink?: (thread: ThreadRow) => Promise<string | undefined>;
	/** Say something in Scout's home channel. */
	announce?: (text: string) => void;
	/** Off for one-off jobs. */
	watchProfile?: boolean;
	/** Where sandboxes run; by default the one `config.sandbox.driver` names. */
	driver?: SandboxDriver;
	/** Model access; by default the Anthropic and OpenAI providers, with keys from the environment. */
	models?: Models;
	/** MCP servers already connected; by default, the ones in `config.mcpFile`. */
	mcp?: McpConnection[];
};

export type Scout = Awaited<ReturnType<typeof openScout>>;

function driverFor(config: Config, dataDir: string, instance: string): SandboxDriver {
	const { sandbox } = config;
	if (sandbox.driver === "spoond") {
		// The relay that carries the daemon's stream reads the token from here (see drivers/spoond-relay.ts).
		process.env.SCOUT_SPOOND_TOKEN = sandbox.spoond!.token;
		return new SpoondDriver({ url: sandbox.spoond!.url, token: sandbox.spoond!.token });
	}
	if (sandbox.driver === "local") {
		console.error("SCOUT_SANDBOX_DRIVER=local: commands run on this host with no isolation. Never with people you don't fully trust.");
		return new LocalDriver({ root: join(dataDir, "sandboxes") });
	}
	return new DockerDriver({ prefix: `scout-${instance}`, openNetwork: sandbox.dockerNetwork });
}

function defaultModels(): Models {
	const models = createModels();
	models.setProvider(anthropicProvider());
	models.setProvider(openaiProvider());
	return models;
}

export async function openScout(options: ScoutOptions) {
	const { config, dataDir, context } = options;
	const announce = options.announce ?? (() => {});
	const db = join(dataDir, "scout.sqlite");
	const threads = new Threads(db);
	const pulls = new Pulls(db);
	const search = new ThreadSearch(db);
	const memory = new Memory(db);
	const workspaces = new Workspaces({
		dataDir,
		instance: options.instance,
		repos: config.repos,
		driver: options.driver ?? driverFor(config, dataDir, options.instance),
		sandbox: {
			image: config.sandbox.image,
			network: config.sandbox.network,
			...(config.sandbox.size === undefined ? {} : { size: config.sandbox.size }),
		},
		git: config.git,
	});
	let reflector: Reflector | undefined;
	let harness: Harness | undefined;

	const models = options.models ?? defaultModels();

	// What Scout knows. With a profile repo, the directory is a clone kept pulled, so merged changes just arrive.
	if (config.profileRepo !== undefined) await cloneProfile(config.profileDir, config.profileRepo);
	let profile: Profile = loadProfile(config.profileDir);
	const repoNamed = (name: string | undefined): RepoConfig => config.repos.find((r) => r.name === name) ?? config.repo;
	/** The repository a conversation works in, as its thread was started with. */
	const repoOf = async (id: number, ctx: Context): Promise<RepoConfig> =>
		repoNamed((await harness?.snapshot(ThreadDoc, id as ConversationId, ctx))?.repo);
	const workspace = {
		repo: repoOf,
		branch: (id: number) => workspaces.branch(id),
		offline: config.sandbox.network === "none",
	};

	const registry = createRegistry();
	const reviewer = reviewExtension(() => profile.review);
	const reviewerAgent: AgentChange = { model: config.model, extensions: [reviewer] };

	// Thread conversations: the profile, coding tools in the thread's container, pull requests against the work repo.
	const profileTools = profileExtension(profile, workspace);
	const codingTools = createCodingTools();
	const workCodeHost = createCodeHostExtension({
		name: "codehost",
		codeHost: config.codeHost,
		target: async (id, ctx) => {
			const link = await options.link?.(id);
			const repo = await repoOf(id, ctx);
			return {
				source: {
					kind: "sandbox",
					status: () => workspaces.status(id),
					exportBranch: () => workspaces.exportBranch(id),
				},
				branch: workspaces.branch(id),
				base: repo.base,
				slug: repo.slug,
				mirror: workspaces.mirrorFor(repo.name),
				...(link === undefined ? {} : { link }),
			};
		},
		onPullRequest: (id, pull) => pulls.opened({ ...pull, kind: "work", conversationId: id }),
		maxChangedLines: config.maxPullLines,
		selfReview: (change, api, ctx) =>
			reviewAsSubtask(
				api,
				{
					agent: reviewerAgent,
					workspace: { sandbox: api.conversationId },
					prompt: [`# ${change.title}`, change.body, "```", change.stat, "```", "```diff", change.diff, "```"].join("\n\n"),
					requestId: `review:${change.sha}`,
				},
				ctx,
			),
	});
	const searchTools = searchExtension(search, threads, options.threadLink ?? (async () => undefined));
	const memoryTools = memoryExtension(memory);

	// Reflection conversations: profile files only, pull requests against the profile repo.
	const reflection = reflectionExtensions(() => profile.reflect);
	const profileCodeHost = createCodeHostExtension({
		name: "profile-codehost",
		codeHost: config.codeHost,
		commitAll: true,
		target: (id, ctx) => {
			if (reflector === undefined) throw new Error("No profile repository is configured.");
			return reflector.target(id, ctx);
		},
		onPullRequest: (id, pull) => {
			pulls.opened({ ...pull, kind: "profile", conversationId: id });
			console.log(`reflection proposed ${pull.url}`);
			announce(`I went over yesterday's threads and wrote down what I learned. Could someone review it? ${pull.url}`);
		},
	});
	const consolidation = consolidationExtension(memory);
	const mcp = options.mcp ?? (config.mcpFile === undefined ? [] : await connectMcp(loadMcpConfig(config.mcpFile)));
	const mcpTools = await mcpExtension(mcp);
	if (mcp.length > 0) console.log(`MCP: ${mcp.map((c) => c.name).join(", ")} (${mcpTools.tools?.length ?? 0} tools)`);

	for (const extension of [
		reviewer,
		profileTools,
		codingTools,
		workCodeHost,
		searchTools,
		memoryTools,
		reflection.reflect,
		reflection.files,
		profileCodeHost,
		consolidation,
		mcpTools,
	]) {
		registry.install(extension);
	}

	const stopWatching =
		options.watchProfile === false
			? () => {}
			: watchProfile(config.profileDir, (next) => {
					profile = next;
					registry.install(profileExtension(profile, workspace));
					console.log("profile reloaded");
				});

	harness = await Harness.open(
		options.storage,
		{
			models,
			registry,
			env: async (target, ctx) =>
				(await reflector?.env(target, ctx)) ??
				(await reviewEnv(target, ctx, (id) => workspaces.env(id))) ??
				workspaces.env(target.conversationId),
			onReport: (report) => console.error("harness:", report),
		},
		context,
	);

	const opened = harness;
	workspaces.repoOf = async (id) => (await opened.snapshot(ThreadDoc, id as ConversationId, context))?.repo;

	if (config.profileRepo !== undefined) {
		reflector = new Reflector({
			harness,
			threads,
			pulls,
			memory,
			codeHost: config.codeHost,
			context,
			dataDir,
			profileRepo: config.profileRepo,
			git: config.git,
			agent: { model: config.model, extensions: [reflection.reflect, reflection.files, profileCodeHost, consolidation] },
			threadLink: options.threadLink ?? (async () => undefined),
		});
	}

	/** The repository a channel's threads work in: its profile's `repo`, if that names one, or the default. */
	const repoFor = (channelName: string): string => {
		const named = profile.channels.get(channelName)?.repo;
		if (named !== undefined && !config.repos.some((r) => r.name === named)) {
			console.error(`#${channelName} names repository ${named}, which isn't configured; using ${config.repo.name}`);
		}
		return repoNamed(named).name;
	};

	/** A channel's own model, from its profile's `model: provider/modelId`. */
	const modelFor = (channelName: string): { provider: string; modelId: string } | undefined => {
		const named = profile.channels.get(channelName)?.model;
		const [provider, ...rest] = named?.split("/") ?? [];
		if (named === undefined) return undefined;
		if (provider === undefined || rest.length === 0 || models.getProvider(provider) === undefined) {
			console.error(`#${channelName} asks for model ${named}, which isn't available; using the default`);
			return undefined;
		}
		return { provider, modelId: rest.join("/") };
	};

	return {
		harness,
		repoFor,
		modelFor,
		threads,
		pulls,
		search,
		memory,
		workspaces,
		reflector,
		/** What a thread (or a job) runs with. */
		workAgent: {
			model: config.model,
			extensions: [profileTools, codingTools, workCodeHost, searchTools, memoryTools, mcpTools],
		} satisfies AgentChange,
		reviewerAgent,
		async close(): Promise<void> {
			stopWatching();
			await harness.close(context);
			await workspaces.close();
			threads.close();
			pulls.close();
			search.close();
			memory.close();
			await closeMcp(mcp);
		},
	};
}
