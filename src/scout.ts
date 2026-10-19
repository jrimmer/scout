import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { type AgentChange, createRegistry, Harness, type Storage } from "@earendil-works/pi-durable";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { createCodeHostExtension } from "./codehost.ts";
import type { Config } from "./config.ts";
import { consolidationExtension, Memory, memoryExtension } from "./memory.ts";
import { cloneProfile, loadProfile, type Profile, profileExtension, watchProfile } from "./profile.ts";
import { Pulls } from "./pulls.ts";
import { Reflector, reflectionExtensions } from "./reflect.ts";
import { reviewAsSubtask, reviewEnv, reviewExtension } from "./review.ts";
import { searchExtension, ThreadSearch } from "./search.ts";
import { Workspaces } from "./sandbox.ts";
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
	/** Model access; by default the Anthropic and OpenAI providers, with keys from the environment. */
	models?: Models;
};

export type Scout = Awaited<ReturnType<typeof openScout>>;

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
	const workspaces = new Workspaces({ ...config, dataDir, instance: options.instance });
	let reflector: Reflector | undefined;

	const models = options.models ?? defaultModels();

	// What Scout knows. With a profile repo, the directory is a clone kept pulled, so merged changes just arrive.
	if (config.profileRepo !== undefined) await cloneProfile(config.profileDir, config.profileRepo);
	let profile: Profile = loadProfile(config.profileDir);
	const workspace = {
		base: config.repo.base,
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
		target: async (id) => {
			const link = await options.link?.(id);
			return {
				dir: workspaces.paths(id).repo,
				branch: workspaces.branch(id),
				base: config.repo.base,
				slug: config.repo.slug,
				mirror: workspaces.mirror,
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
					root: workspaces.paths(api.conversationId).root,
					cwd: change.target.dir,
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

	const harness = await Harness.open(
		options.storage,
		{
			models,
			registry,
			env: async (target, ctx) =>
				(await reflector?.env(target, ctx)) ?? (await reviewEnv(target, ctx)) ?? workspaces.env(target.conversationId),
			onReport: (report) => console.error("harness:", report),
		},
		context,
	);

	if (config.profileRepo !== undefined) {
		reflector = new Reflector({
			harness,
			threads,
			pulls,
			memory,
			context,
			dataDir,
			profileRepo: config.profileRepo,
			git: config.git,
			agent: { model: config.model, extensions: [reflection.reflect, reflection.files, profileCodeHost, consolidation] },
			threadLink: options.threadLink ?? (async () => undefined),
		});
	}

	return {
		harness,
		threads,
		pulls,
		search,
		memory,
		workspaces,
		reflector,
		/** What a thread (or a job) runs with. */
		workAgent: {
			model: config.model,
			extensions: [profileTools, codingTools, workCodeHost, searchTools, memoryTools],
		} satisfies AgentChange,
		reviewerAgent,
		async close(): Promise<void> {
			stopWatching();
			await harness.close(context);
			threads.close();
			pulls.close();
			search.close();
			memory.close();
		},
	};
}
