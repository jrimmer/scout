import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { Models } from "@earendil-works/pi-ai/models";
import { Type } from "@earendil-works/pi-ai";
import { type AgentChange, type ConversationId, createRegistry, defineExtension, defineTool, type Extension, Harness, ProviderDoc, type Storage } from "@earendil-works/pi-durable";
import { Capacity, limitModels, minutes, ModelBreakers, ModelLimiter, WaitBoard } from "./capacity.ts";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { createCodeHostExtension, type OpenedPull } from "./codehost.ts";
import type { Config, RepoConfig } from "./config.ts";
import { modelsFor } from "./gateway.ts";
import { Audit } from "./audit.ts";
import { type Admission, Limits, loadLimits, SpendLedger } from "./limits.ts";
import { observeExtension, type Observer } from "./observe.ts";
import { loadPeople, Permissions } from "./permissions.ts";
import { Pricing } from "./pricing.ts";
import { Counters, Tracer } from "./telemetry.ts";
import { AutheliaFile, approversOf, loadRoles, requestersOf } from "./directory.ts";
import { codeSearchExtension } from "./codesearch.ts";
import { Approaches, approachesExtension, type ApproachesOptions, chooseApproach } from "./approaches.ts";
import { egressExtension } from "./egress.ts";
import { Images } from "./images.ts";
import { allows } from "./initiative.ts";
import { DEFAULT_EMOJI, type Ending, type Phase } from "./reactions.ts";
import { CODEOWNERS_PATHS, type Owners, ownersOf, parseCodeOwners, recentOwners } from "./owners.ts";
import { Schedules, schedulesExtension } from "./schedules.ts";
import { Approvals, closeMcp, connectMcp, loadMcpConfig, type McpConnection, mcpExtension } from "./mcp.ts";
import { ThreadDoc } from "./docs.ts";
import { consolidationExtension, Memory, memoryExtension } from "./memory.ts";
import { cloneProfile, loadProfile, type Profile, profileExtension, watchProfile } from "./profile.ts";
import { Pulls } from "./pulls.ts";
import { Reflector, reflectionExtensions } from "./reflect.ts";
import { type Alert, type AlertPolicy, alertMatches, DEFAULT_RESPONDER_INSTRUCTIONS } from "./alerts.ts";
import { DEFAULT_PULL_REVIEW_INSTRUCTIONS, reviewAsSubtask, reviewEnv, reviewExtension } from "./review.ts";
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
	/** A reflection proposed profile changes: say so where people can reply (a thread the reflection then answers in). */
	reflectionProposed?: (conversationId: number, text: string) => void;
	/** Scout opened a new pull request from a conversation (not an update to one). */
	pullOpened?: (conversationId: number, pull: OpenedPull) => void;
	/** Off for one-off jobs. */
	watchProfile?: boolean;
	/** Where sandboxes run; by default the one `config.sandbox.driver` names. */
	driver?: SandboxDriver;
	/** A model call for provider session `session` started answering `ms` after it was sent: for the evals. */
	modelStarted?: (session: string, ms: number) => void;
	/** A pull request's self-review took `ms` (a model run of its own, inside `open_pull_request`): for the evals. */
	selfReviewed?: (conversationId: number, ms: number) => void;
	/** Model access; by default the Anthropic and OpenAI providers, with keys from the environment. */
	models?: Models;
	/** MCP servers already connected; by default, the ones in `config.mcpFile`. */
	mcp?: McpConnection[];
	/** Members of a Slack user group, for `governance.allowedUserGroup`. */
	groupMembers?: (group: string) => Promise<Set<string>>;
	/** A Slack user's email, to find them in the identity provider (directory.ts). */
	emailOf?: (user: string) => Promise<string | undefined>;
	fetch?: typeof fetch;
};

const DAY = 24 * 60 * 60 * 1000;

export type Scout = Awaited<ReturnType<typeof openScout>>;

function driverFor(config: Config, dataDir: string, instance: string, onWait?: (key: string, waiting: boolean) => void): SandboxDriver {
	const { sandbox } = config;
	if (sandbox.driver === "spoond") {
		// The relay that carries the daemon's stream reads the token from here (see drivers/spoond-relay.ts).
		process.env.SCOUT_SPOOND_TOKEN = sandbox.spoond!.token;
		const { url, token, transport } = sandbox.spoond!;
		return new SpoondDriver({ url, token, transport, patience: config.capacity.sandboxPatience, ...(onWait === undefined ? {} : { onWait }) });
	}
	if (sandbox.driver === "local") {
		console.error("SCOUT_SANDBOX_DRIVER=local: commands run on this host with no isolation. Never with people you don't fully trust.");
		return new LocalDriver({ root: join(dataDir, "sandboxes") });
	}
	return new DockerDriver({ prefix: `scout-${instance}`, openNetwork: sandbox.dockerNetwork });
}

export async function openScout(options: ScoutOptions) {
	const { config, dataDir, context } = options;
	const announce = options.announce ?? (() => {});
	const db = join(dataDir, "scout.sqlite");
	const threads = new Threads(db);
	const pulls = new Pulls(db);
	const search = new ThreadSearch(db);
	const memory = new Memory(db);
	// Capacity (capacity.ts): what waits, for how long, and what to tell people about it.
	const capacity = new Capacity(db);
	const board = new WaitBoard();
	const workspaces = new Workspaces({
		dataDir,
		instance: options.instance,
		repos: config.repos,
		driver: options.driver ?? driverFor(config, dataDir, options.instance, (key, waiting) => {
			if (waiting) board.start("sandbox", key);
			else capacity.waited("sandbox", board.end("sandbox", key));
		}),
		sandbox: {
			image: config.sandbox.image,
			network: config.sandbox.network,
			...(config.sandbox.size === undefined ? {} : { size: config.sandbox.size }),
		},
		git: config.git,
	});
	let reflector: Reflector | undefined;
	let harness: Harness | undefined;

	// Model calls take turns: at most SCOUT_MAX_MODEL_CALLS at once, so a busy moment queues instead of overrunning the
	// gateway, and each run can say it's waiting.
	const modelLimiter = new ModelLimiter({ max: config.capacity.maxModelCalls, board, onWaited: (ms) => capacity.waited("model", ms) });
	const catalog = options.models ?? modelsFor(config.gateway);
	// A model that keeps failing hands its calls to a fallback until it answers again (SCOUT_FALLBACK_MODELS). Saying so
	// in the home channel is looking after its own work (initiative.ts); the threads say so whatever the level.
	const { fallback } = config;
	for (const m of fallback?.models ?? []) {
		if (catalog.getModel(m.provider, m.modelId) === undefined) throw new Error(`SCOUT_FALLBACK_MODELS: there's no model ${m.provider}/${m.modelId} (a model only the gateway knows is gateway/<its name>)`);
	}
	const breakers =
		fallback === undefined
			? undefined
			: new ModelBreakers({ fallbacks: fallback.models.map((m) => `${m.provider}/${m.modelId}`), after: fallback.after, forMs: fallback.minutes * 60_000, ...(allows(config.initiative, "own") ? { say: announce } : {}) });
	const models = limitModels(
		catalog,
		modelLimiter,
		(ms, session) => {
			capacity.firstToken(ms);
			options.modelStarted?.(session, ms);
		},
		breakers,
	);

	// What Scout knows. With a profile repo, the directory is a clone kept pulled, so merged changes just arrive.
	if (config.profileRepo !== undefined) await cloneProfile(config.profileDir, config.profileRepo);
	let profile: Profile = loadProfile(config.profileDir);
	for (const problem of profile.problems) console.warn(`profile: ${problem}`);
	const repoNamed = (name: string | undefined): RepoConfig => config.repos.find((r) => r.name === name) ?? config.repo;
	/** The repository a conversation works in, as its thread was started with. */
	/** A conversation's repository, with its own base branch when it has one (a pull request review's thread). */
	const repoOf = async (id: number, ctx: Context): Promise<RepoConfig> => {
		const doc = await harness?.snapshot(ThreadDoc, id as ConversationId, ctx);
		const repo = repoNamed(doc?.repo);
		return doc?.base === undefined ? repo : { ...repo, base: doc.base };
	};
	const workspace = {
		repo: repoOf,
		branch: (id: number) => workspaces.branch(id),
		offline: config.sandbox.network === "none",
	};

	// Governance: every conversation's model calls and tool calls pass the observers (observe.ts).
	const { governance } = config;
	const pricing = Pricing.load(governance.pricesFile);
	const audit = new Audit(db);
	const spend = new SpendLedger(db, pricing);
	// Runs at once: the limits file's say, else SCOUT_MAX_RUNS in all and SCOUT_MAX_RUNS_PER_CHANNEL per channel.
	const limitsConfig = loadLimits(governance.limitsFile);
	limitsConfig.concurrency = { total: config.capacity.maxRuns, perChannel: config.capacity.maxRunsPerChannel, ...limitsConfig.concurrency };
	const limits = new Limits(limitsConfig, spend, pricing);
	const counters = new Counters(pricing);
	const tracer = governance.otlp === undefined ? undefined : new Tracer({ ...governance.otlp, pricing });
	// The identity provider: who a Slack user is (by email), their code host login, and their groups.
	const directory = governance.directory === undefined ? undefined : new AutheliaFile(sourceReader(governance.directory.source, config.codeHost, options.fetch ?? fetch));
	const people = loadPeople(governance.peopleFile);
	/** A Slack user in the directory: by the people file's login, or else by their Slack email. */
	const personOf = async (user: string) => {
		if (directory === undefined) return undefined;
		const login = people[user];
		if (login !== undefined) return directory.byUsername(login);
		const email = await options.emailOf?.(user);
		return email === undefined ? undefined : directory.byEmail(email);
	};
	const roles = loadRoles(governance.rolesFile);
	const refuseApprover = async (user: string, server: string): Promise<string | undefined> => {
		const groups = approversOf(roles, server);
		if (groups === undefined) return undefined;
		const person = await personOf(user).catch(() => undefined);
		if (person?.groups.some((g) => groups.includes(g)) === true) return undefined;
		return `changes to ${server} need someone in ${groups.join(" or ")}${person === undefined ? ", and I couldn't find who approved in the directory" : ""}.`;
	};
	/** May this person ask for work in this repository: by the roles file's groups, or else the code host's say. */
	const mayRequest = async (user: string, repo: RepoConfig): Promise<Admission> => {
		const groups = requestersOf(roles, repo.name);
		if (groups === undefined || !permissions.enforcing) return permissions.admit(user, repo.slug);
		const person = await personOf(user).catch(() => undefined);
		if (person === undefined) return { ok: false, reason: "I can't find you in the directory, so I can't check you may ask me for work here. Ask whoever runs me to link your account." };
		if (person.groups.some((g) => groups.includes(g))) return { ok: true };
		return { ok: false, reason: `I can only take work in ${repo.name} from people in ${groups.join(" or ")}. Ask an admin to add you.` };
	};
	/** The same, for someone asking on the code host: their login is their directory username. */
	const mayAsk = async (login: string, repo: Pick<RepoConfig, "name" | "slug">): Promise<Admission> => {
		const groups = requestersOf(roles, repo.name);
		if (groups === undefined || !permissions.enforcing) return permissions.admitLogin(login, repo.slug);
		const person = directory === undefined ? undefined : await directory.byUsername(login).catch(() => undefined);
		if (person === undefined) return { ok: false, reason: `I can't find ${login} in the directory, so I can't check you may ask me for work here. Ask whoever runs me to add you.` };
		if (person.groups.some((g) => groups.includes(g))) return { ok: true };
		return { ok: false, reason: `I can only take work in ${repo.name} from people in ${groups.join(" or ")}. Ask an admin to add you.` };
	};
	/** Who should review a change to these files: their CODEOWNERS, or else who changed them lately (owners.ts). */
	const reviewersFor = async (repoName: string, files: readonly string[], exclude: readonly string[]): Promise<Owners> => {
		const skip = new Set(exclude.map((e) => e.toLowerCase()));
		for (const path of CODEOWNERS_PATHS) {
			const text = await workspaces.readBase(repoName, path);
			if (text === undefined) continue;
			const owners = ownersOf(parseCodeOwners(text), files);
			return { users: owners.users.filter((u) => !skip.has(u.toLowerCase())), teams: owners.teams };
		}
		const emails = await workspaces.recentAuthors(repoName, files).catch(() => []);
		const logins = await Promise.all(emails.map(async (email) => (directory === undefined ? undefined : (await directory.byEmail(email).catch(() => undefined))?.username)));
		return { users: recentOwners(logins, exclude), teams: [] };
	};
	/** A Slack user's code host login, and the reverse, from the people file and the directory. */
	const loginOf = async (user: string): Promise<string | undefined> => (await personOf(user).catch(() => undefined))?.username;
	const slackUserOf = (login: string): string | undefined => Object.entries(people).find(([, l]) => l.toLowerCase() === login.toLowerCase())?.[0];
	const permissions = new Permissions({
		loginOf: async (user) => (await personOf(user))?.username,
		config: {
			mode: governance.requesterCheck,
			people,
			...(governance.allowedUserGroup === undefined ? {} : { userGroup: governance.allowedUserGroup }),
		},
		codeHost: config.codeHost,
		...(options.groupMembers === undefined || governance.allowedUserGroup === undefined
			? {}
			: { groupMembers: () => options.groupMembers!(governance.allowedUserGroup!) }),
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
	});
	const observers: Observer[] = [audit, limits, spend, counters, ...(tracer === undefined ? [] : [tracer])];
	const observe = observeExtension(observers, (event, reason) =>
		audit.record("blocked", { actor: "scout", conversationId: event.conversationId, channel: event.channel, detail: { tool: event.name, reason } }),
	);

	const registry = createRegistry();
	const reviewer = reviewExtension(() => profile.review);
	const reviewerAgent: AgentChange = { model: config.model, extensions: [reviewer, observe] };

	// Thread conversations: the profile, coding tools in the thread's container, pull requests against the work repo.
	const profileTools = profileExtension(profile, workspace);
	const codingTools = createCodingTools();
	const workCodeHost = createCodeHostExtension({
		name: "codehost",
		codeHost: config.codeHost,
		selfEmail: config.git.email,
		target: async (id, ctx) => {
			const link = await options.link?.(id);
			const repo = await repoOf(id, ctx);
			return {
				source: {
					kind: "sandbox",
					status: () => workspaces.status(id),
					exportBranch: () => workspaces.exportBranch(id),
					importBranch: (bundle, branch) => workspaces.importBranch(id, bundle, branch),
				},
				branch: workspaces.branch(id),
				base: repo.base,
				slug: repo.slug,
				mirror: workspaces.mirrorFor(repo.name),
				...(link === undefined ? {} : { link }),
			};
		},
		onPullRequest: (id, pull) => {
			if (pulls.opened({ ...pull, kind: "work", conversationId: id })) options.pullOpened?.(id, pull);
			audit.record("pull_opened", { actor: "scout", conversationId: id, detail: { url: pull.url, title: pull.title } });
		},
		maxChangedLines: config.maxPullLines,
		selfReview: async (change, api, ctx) => {
			const started = Date.now();
			try {
				return await reviewAsSubtask(
					api,
					{
						agent: reviewerAgent,
						workspace: { sandbox: api.conversationId },
						prompt: [`# ${change.title}`, change.body, "```", change.stat, "```", "```diff", change.diff, "```"].join("\n\n"),
						requestId: `review:${change.sha}`,
					},
					ctx,
				);
			} finally {
				options.selfReviewed?.(api.conversationId, Date.now() - started);
			}
		},
	});
	const searchTools = searchExtension(search, threads, options.threadLink ?? (async () => undefined));
	const memoryTools = memoryExtension(memory, audit);
	// "What are you working on?": Scout's live state, which only the service running it knows (main.ts sets this).
	let describeNow: (channel: string) => Promise<string> = async () => "I can't see my other threads from here.";
	const statusTools = defineExtension({
		name: "status",
		tools: [
			defineTool({
				name: "scout_status",
				description:
					"What you're doing right now across all your threads, what's waiting to start, which threads are waiting on " +
					"people, and this channel's schedules. Use it when someone asks what you're working on or how busy you are.",
				parameters: Type.Object({}),
				execute: async (_args, api, ctx) => {
					const channel = (await api.snapshot(ThreadDoc, api.conversationId, ctx))?.channelName ?? "";
					return { output: [{ type: "text", text: await describeNow(channel) }] };
				},
			}),
		],
	});
	// A sandbox that can't reach a host asks whoever runs Scout to allow it (egress.ts); the service posts the question.
	let proposeEgress: (conversationId: number, host: string, why: string) => Promise<string> = async () => "I can't ask anyone about network access from here.";
	const egressTools = egressExtension((id, host, why) => proposeEgress(id, host, why));
	// Every repository's code, from any thread: the host's mirrors, read-only (codesearch.ts).
	const codeSearchTools = codeSearchExtension(() => config.repos.map((r) => ({ name: r.name, base: r.base, mirror: workspaces.mirrorFor(r.name) })));
	// Experimental: several approaches at once, compared in the thread (approaches.ts). Where the comparison goes is the
	// service's to say (main.ts sets it); each approach works without this tool, and without opening pull requests.
	const approaches = new Approaches(db);
	let showApproaches: ApproachesOptions["show"] = async () => undefined;
	// How many approaches may run at once for a thread, given the run limits (main.ts sets it; it can see every run).
	let approachRoom: (parentId: number) => Promise<number> = async () => Number.POSITIVE_INFINITY;
	const approachesTools: Extension = approachesExtension({
		store: approaches,
		workspaces,
		costOf: (id, since) => spend.spentOn(id, since).cost,
		show: (parentId, message, ts) => showApproaches(parentId, message, ts),
		room: (parentId) => approachRoom(parentId),
		onWaited: (ms) => capacity.waited("run", ms),
		childWithout: () => [approachesTools, workCodeHost],
	});
	const schedules = new Schedules(db);
	// Each repository's image, built from its own setup script (images.ts); new threads start from it.
	const images = new Images(db);
	workspaces.builtImage = (repo) => images.get(repo)?.snapshot;
	// Who asked for a schedule change: the latest person to ask for work in the thread.
	const scheduleTools = schedulesExtension(schedules, (id) => threads.byConversation(id)?.lastAsker ?? "scout", audit);

	// Reflection conversations: profile files only, pull requests against the profile repo.
	const reflection = reflectionExtensions(() => profile.reflect);
	const profileCodeHost = createCodeHostExtension({
		name: "profile-codehost",
		codeHost: config.codeHost,
		selfEmail: config.git.email,
		commitAll: true,
		target: (id, ctx) => {
			if (reflector === undefined) throw new Error("No profile repository is configured.");
			return reflector.target(id, ctx);
		},
		onPullRequest: (id, pull) => {
			const first = pulls.opened({ ...pull, kind: "profile", conversationId: id });
			audit.record("pull_opened", { actor: "scout", conversationId: id, detail: { url: pull.url, title: pull.title, profile: true } });
			console.log(`reflection ${first ? "proposed" : "revised"} ${pull.url}`);
			// A revision updates the same pull request; its thread already knows.
			if (!first) return;
			const text = `I went over yesterday's threads and wrote down what I learned. Could someone review it? ${pull.url}\nComment on the pull request, or ask me here, and I'll revise it.`;
			if (options.reflectionProposed === undefined) announce(text);
			else options.reflectionProposed(id, text);
		},
	});
	const consolidation = consolidationExtension(memory);
	const mcp = options.mcp ?? (config.mcpFile === undefined ? [] : await connectMcp(loadMcpConfig(config.mcpFile)));
	const approvals = new Approvals(db);
	const mcpTools = await mcpExtension(mcp, approvals, refuseApprover);
	if (mcp.length > 0) console.log(`MCP: ${mcp.map((c) => c.name).join(", ")} (${mcpTools.tools?.length ?? 0} tools)`);
	// Reviewing other people's pull requests when asked: read-only files, the profile's reviewer.md, and the MCP tools
	// (CI logs above all) a thread outside any channel gets.
	const pullReviewer = reviewExtension(() => profile.reviewer, DEFAULT_PULL_REVIEW_INSTRUCTIONS, "pull-review");
	const pullReviewerAgent: AgentChange = { model: config.model, extensions: [pullReviewer, mcpTools, observe] };

	for (const extension of [
		reviewer,
		pullReviewer,
		profileTools,
		codingTools,
		workCodeHost,
		searchTools,
		memoryTools,
		scheduleTools,
		statusTools,
		codeSearchTools,
		egressTools,
		approachesTools,
		reflection.reflect,
		reflection.files,
		profileCodeHost,
		consolidation,
		mcpTools,
		observe,
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
					for (const problem of profile.problems) console.warn(`profile: ${problem}`);
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
			settings: {
				// A busy gateway can queue requests for minutes ("scheduler admission timeout"): Pi's default three
				// retries over about 14 seconds gave up too soon. Six, from 5 s and doubling up to a minute, wait it out
				// for about three minutes. The thread says it's taking longer meanwhile (render.ts).
				retry: { enabled: true, maxRetries: 6, baseDelayMs: 5_000, maxAgentDelayMs: 60_000 },
			},
		},
		context,
	);

	const opened = harness;
	workspaces.repoOf = async (id) => (await opened.snapshot(ThreadDoc, id as ConversationId, context))?.repo;
	workspaces.baseOf = async (id) => (await opened.snapshot(ThreadDoc, id as ConversationId, context))?.base;
	workspaces.describe = async (id) => {
		const first = search.first(id);
		const thread = threads.byConversation(id);
		const link = thread === undefined ? undefined : await options.threadLink?.(thread);
		return {
			...(first === undefined ? {} : { about: `#${first.channelName}: ${slackPlain(first.text)}` }),
			...(link === undefined ? {} : { link }),
		};
	};

	if (config.profileRepo !== undefined) {
		reflector = new Reflector({
			waits: () => capacity.weekLine(),
			harness,
			threads,
			pulls,
			memory,
			codeHost: config.codeHost,
			context,
			dataDir,
			profileRepo: config.profileRepo,
			git: config.git,
			agent: { model: config.model, extensions: [reflection.reflect, reflection.files, profileCodeHost, consolidation, observe] },
			threadLink: options.threadLink ?? (async () => undefined),
		});
	}

	/**
	 * The repository a thread works in: of its channel's `repo` list, the one its first message (`text`) names first,
	 * or else the list's first; with no list, the default repository.
	 */
	const repoFor = (channelName: string, text?: string): string => {
		const named = profile.channels.get(channelName)?.repos ?? [];
		const configured = named.filter((name) => {
			const known = config.repos.some((r) => r.name === name);
			if (!known) console.error(`#${channelName} names repository ${name}, which isn't configured`);
			return known;
		});
		const mentioned = configured
			.map((name) => ({ name, at: text?.search(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i")) ?? -1 }))
			.filter((m) => m.at >= 0)
			.sort((a, b) => a.at - b.at)[0]?.name;
		return repoNamed(mentioned ?? configured[0]).name;
	};

	/** The channel whose profile names this repository, and what its team wants Scout to know. */
	const channelOf = (repoName: string): { name: string; instructions?: string } | undefined => {
		for (const [name, channel] of profile.channels) {
			if (channel.repos.includes(repoName)) return { name, ...(channel.instructions === undefined ? {} : { instructions: channel.instructions }) };
		}
		return undefined;
	};

	/** The channel whose profile claims this alert (`alerts:` matching one of its labels), and whom to mention. */
	const alertChannel = (alert: Alert): { name: string; oncall?: string } | undefined => {
		for (const [name, channel] of profile.channels) {
			if (channel.alerts.some((term) => alertMatches(alert, term))) return { name, ...(channel.oncall === undefined ? {} : { oncall: channel.oncall }) };
		}
		return undefined;
	};
	/** How Scout looks into an alert: the profile's `responder.md`. */
	const responder = (): string => profile.responder ?? DEFAULT_RESPONDER_INSTRUCTIONS;
	/** Which alerts to investigate or ignore, and when they count: the frontmatter of `responder.md`. */
	const alertPolicy = (source: Alert["source"]): AlertPolicy => profile.alertPolicy[source];
	/** A request's reaction for a phase: the profile's reactions.md, else the default. */
	const reactionEmoji = (phase: Phase | Ending): string => profile.reactions[phase] ?? DEFAULT_EMOJI[phase];

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

	/**
	 * May this request go ahead? The requester's access to the repository first (if enforced), then, for work that
	 * would start a run, budgets and concurrency. `working` is the runs going now, by channel.
	 */
	const admitter =
		(working: () => Promise<{ channel: string }[]>) =>
		async (request: { user: string; channelName: string; repo?: string; starting: boolean }): Promise<Admission> => {
			// Work Scout starts itself (an alert's investigation) answers to budgets and concurrency, not to a person's access.
			const allowed = request.user === "scout" ? ({ ok: true } as const) : await mayRequest(request.user, repoNamed(request.repo));
			if (!allowed.ok || !request.starting) return allowed;
			return limits.admit(request.channelName, await working());
		};

	return {
		harness,
		repoFor,
		channelOf,
		mayAsk,
		reviewersFor,
		loginOf,
		slackUserOf,
		approvals,
		schedules,
		images,
		/** What `ask_for_network` does: set by the service, which can post the question and hear the answer. */
		setEgress: (propose: (conversationId: number, host: string, why: string) => Promise<string>) => {
			proposeEgress = propose;
		},
		/** The repository a conversation works in. */
		repoOfConversation: (id: number) => repoOf(id, context),
		/** Why this person may not approve changes to `server` (an MCP server, or "egress"), if they may not. */
		refuseApprover,
		approaches,
		capacity,
		board,
		modelLimiter,
		/** The fallback models' breakers, when SCOUT_FALLBACK_MODELS names some. */
		breakers,
		/** What a thread says when its model calls went to a fallback model in this outage, or nothing. */
		fallbackNotice: async (conversationId: number): Promise<string | undefined> => {
			if (breakers === undefined) return undefined;
			const provider = await harness?.snapshot(ProviderDoc, conversationId as ConversationId, context).catch(() => undefined);
			return provider === undefined ? undefined : breakers.notice(provider.sessionId);
		},
		/** What a run is waiting on right now, in Scout's words, or nothing: a sandbox on a full host, or the model. */
		waitingFor: async (conversationId: number): Promise<string | undefined> => {
			const now = Date.now();
			const sandboxSince = board.since("sandbox", workspaces.key(conversationId));
			if (sandboxSince !== undefined) {
				const usual = capacity.waits("sandbox", 7 * DAY, now);
				return `Waiting for a workspace: the sandbox host is full right now (${minutes(now - sandboxSince)} so far). ${usual.count >= 3 ? `It usually frees up within ${minutes(usual.p90)}.` : "I'll carry on as soon as there's room."}`;
			}
			const provider = harness === undefined ? undefined : await harness.snapshot(ProviderDoc, conversationId as ConversationId, context).catch(() => undefined);
			const position = provider === undefined ? undefined : modelLimiter.position(provider.sessionId);
			if (position === undefined) return undefined;
			const usual = capacity.waits("model", DAY, now);
			const ahead = position === 1 ? "I'm next" : `${position - 1} ahead of me`;
			return `Waiting my turn for the model: it's busy with other threads, ${ahead}.${usual.count >= 5 ? ` That usually takes under ${minutes(usual.p90)}.` : ""}`;
		},
		/** How many approaches a thread may run at once: set by the service, which sees every run. */
		setApproachRoom: (room: (parentId: number) => Promise<number>) => {
			approachRoom = room;
		},		/** Where a thread's comparison of approaches is shown: set by the service. */
		setApproachesView: (show: ApproachesOptions["show"]) => {
			showApproaches = show;
		},
		/** Someone chose one of a thread's approaches: its commits come onto the thread's branch. */
		chooseApproach: (parentId: number, index: number, by: string) => chooseApproach({ store: approaches, workspaces }, parentId, index, by),
		/** What `scout_status` tells a thread: set by the service, which can see every thread. */
		setStatus: (describe: (channel: string) => Promise<string>) => {
			describeNow = describe;
		},
		/** Build the images that are due (only where the sandboxes can be saved as images). */
		refreshImages: () =>
			workspaces.driver.snapshot === undefined
				? Promise.resolve([])
				: images.refresh({
						repos: () => config.repos.map((r) => r.name),
						setup: (repo) => workspaces.setupScript(repo),
						build: (repo, label) => workspaces.buildImage(repo, label),
					}),
		alertChannel,
		responder,
		alertPolicy,
		reactionEmoji,
		admitter,
		audit,
		spend,
		limits,
		counters,
		pricing,
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
			extensions: [
				profileTools,
				codingTools,
				workCodeHost,
				searchTools,
				memoryTools,
				scheduleTools,
				statusTools,
				...(config.codeSearch ? [codeSearchTools] : []),
				...(config.parallel ? [approachesTools] : []),
				egressTools,
				mcpTools,
				observe,
			],
		} satisfies AgentChange,
		reviewerAgent,
		pullReviewerAgent,
		async close(): Promise<void> {
			stopWatching();
			await harness.close(context);
			await workspaces.close();
			threads.close();
			pulls.close();
			search.close();
			memory.close();
			approvals.close();
			schedules.close();
			images.close();
			capacity.close();
			await tracer?.close();
			audit.close();
			spend.close();
			await closeMcp(mcp);
		},
	};
}

/** Where the directory reads its file: a path, or a URL (with the code host's token when it's the code host's). */
/** Reads the directory's users file: a path, or a URL (with the code host's token when it's on the code host). */
export function sourceReader(source: string, codeHost: Config["codeHost"], doFetch: typeof fetch): () => Promise<string> {
	if (!/^https?:\/\//.test(source)) return async () => readFileSync(source, "utf8");
	const sameHost = new URL(source).origin === new URL(codeHost.apiUrl).origin;
	return async () => {
		const response = await doFetch(source, sameHost ? { headers: { authorization: codeHost.kind === "github" ? `Bearer ${codeHost.token}` : `token ${codeHost.token}` } } : {});
		if (!response.ok) throw new Error(`the directory at ${source} answered ${response.status}`);
		return response.text();
	};
}

/** Slack's markup as plain words: `<@U…>` mentions dropped, `<#C…|name>` as `#name`, links as their text. */
function slackPlain(text: string): string {
	return text
		.replace(/^@Scout\b/, "")
		.replace(/<@[^>]+>/g, "")
		.replace(/<#[^|>]+\|([^>]+)>/g, "#$1")
		.replace(/<[^|>]+\|([^>]+)>/g, "$1")
		.replace(/<([^>]+)>/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}
