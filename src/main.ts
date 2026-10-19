import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createCodingTools } from "@earendil-works/pi-durable/tools";
import { Bridge } from "./bridge.ts";
import { createCodeHostExtension } from "./codehost.ts";
import { loadConfig } from "./config.ts";
import { cloneProfile, loadProfile, profileExtension, pullProfile, watchProfile } from "./profile.ts";
import { consolidationExtension, Memory, memoryExtension } from "./memory.ts";
import { Pulls, weekOf } from "./pulls.ts";
import { reviewAsSubtask, reviewEnv, reviewExtension } from "./review.ts";
import { searchExtension, ThreadSearch } from "./search.ts";
import { localDay, Reflector, reflectionExtensions } from "./reflect.ts";
import { Workspaces } from "./sandbox.ts";
import { Slack } from "./slack.ts";
import { Threads } from "./threads.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const context = BACKGROUND_CONTEXT;
const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
// Every git command the host runs (clone, fetch, push, profile pulls) uses Scout's own key. Containers never see it.
if (config.git.sshKey !== undefined) {
	process.env.GIT_SSH_COMMAND = `ssh -i '${config.git.sshKey}' -o IdentitiesOnly=yes -o IdentityAgent=none`;
}

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openaiProvider());

const threads = new Threads(join(config.dataDir, "scout.sqlite"));
const pulls = new Pulls(join(config.dataDir, "scout.sqlite"));
const search = new ThreadSearch(join(config.dataDir, "scout.sqlite"));
const memory = new Memory(join(config.dataDir, "scout.sqlite"));
const workspaces = new Workspaces({ ...config, instance: instanceId(config.dataDir) });
const slack = new Slack(config.slack);
let reflector: Reflector | undefined;

// What Scout knows. With a profile repo, the directory is a clone kept pulled, so merged changes just arrive.
if (config.profileRepo !== undefined) await cloneProfile(config.profileDir, config.profileRepo);
let profile = loadProfile(config.profileDir);
const workspace = {
	base: config.repo.base,
	branch: (id: number) => workspaces.branch(id),
	offline: config.sandbox.network === "none",
};
if (workspace.offline) {
	console.log("sandbox network: none. Installs and downloads will fail; set SCOUT_SANDBOX_NETWORK=bridge to allow them.");
}

// Thread conversations: the profile, coding tools in the thread's container, pull requests against the work repo.
const registry = createRegistry();
const reviewer = reviewExtension(() => profile.review);
registry.install(reviewer);
const profileTools = profileExtension(profile, workspace);
const codingTools = createCodingTools();
const workCodeHost = createCodeHostExtension({
	name: "codehost",
	codeHost: config.codeHost,
	target: async (id) => {
		const thread = threads.byConversation(id);
		const link = thread === undefined ? undefined : await slack.permalink(thread.channel, thread.threadTs);
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
				agent: { model: config.model, extensions: [reviewer] },
				root: workspaces.paths(api.conversationId).root,
				cwd: change.target.dir,
				prompt: [`# ${change.title}`, change.body, "```", change.stat, "```", "```diff", change.diff, "```"].join("\n\n"),
				requestId: `review:${change.sha}`,
			},
			ctx,
		),
});
const searchTools = searchExtension(search, threads, (thread) => slack.permalink(thread.channel, thread.threadTs));
registry.install(profileTools);
registry.install(codingTools);
registry.install(workCodeHost);
registry.install(searchTools);
const memoryTools = memoryExtension(memory);
registry.install(memoryTools);

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
registry.install(reflection.reflect);
registry.install(reflection.files);
registry.install(profileCodeHost);
registry.install(consolidation);

const stopWatching = watchProfile(config.profileDir, (next) => {
	profile = next;
	registry.install(profileExtension(profile, workspace));
	console.log("profile reloaded");
});

const harness = await Harness.open(
	await openNodeSqliteStorage(join(config.dataDir, "pi.sqlite")),
	{
		models,
		registry,
		env: async (target, ctx) =>
			(await reflector?.env(target, ctx)) ?? (await reviewEnv(target, ctx)) ?? workspaces.env(target.conversationId),
		onReport: (report) => console.error("harness:", report),
	},
	context,
);
harness.closed.then((end) => {
	if (end.reason === "failed") {
		console.error("harness failed; exiting so the supervisor restarts us:", end.error);
		process.exit(1);
	}
});

if (config.profileRepo !== undefined) {
	reflector = new Reflector({
		harness,
		threads,
		pulls,
		memory,
		context,
		dataDir: config.dataDir,
		profileRepo: config.profileRepo,
		git: config.git,
		agent: { model: config.model, extensions: [reflection.reflect, reflection.files, profileCodeHost, consolidation] },
		threadLink: (thread) => slack.permalink(thread.channel, thread.threadTs),
	});
} else {
	console.log("no SCOUT_PROFILE_REPO_URL: the nightly reflection is off");
}

const bridge = new Bridge({
	harness,
	threads,
	surface: slack.surface,
	botUserId: await slack.identify(),
	nameOf: (user) => slack.nameOf(user),
	agent: { model: config.model, extensions: [profileTools, codingTools, workCodeHost, searchTools, memoryTools] },
	context,
	channelOffer: (user) => slack.channelOffer(user),
	search,
});

await bridge.reattach(Date.now() - 24 * HOUR);
harness.resume();
await slack.start({
	onMessage: (message) => bridge.onMessage(message),
	onReaction: (reaction) => bridge.onReaction(reaction),
});
console.log(`scout is listening as <@${slack.botUserId}> (model ${config.model.provider}/${config.model.modelId})`);

async function reflect(day: string): Promise<void> {
	if (reflector === undefined) return;
	try {
		const started = await reflector.run(day);
		if (started !== undefined) console.log(`reflecting on ${started.threads} thread(s) for ${day}`);
	} catch (error) {
		console.error(`reflection for ${day} failed:`, error);
	}
}

const tick = setInterval(() => {
	const now = Date.now();
	// Containers are cattle: stop the ones whose threads went quiet; the next tool call starts them again.
	for (const thread of threads.activeSince(now - 24 * HOUR)) {
		if (thread.lastActivity < now - HOUR && !bridge.view(thread.conversationId)?.busy) {
			void workspaces.stop(thread.conversationId);
		}
	}
	if (config.profileRepo !== undefined) {
		pullProfile(config.profileDir).catch((error: unknown) => console.error("profile pull failed:", error));
	}
	if (new Date(now).getHours() >= config.reflect.hour) void reflect(localDay(new Date(now)));
	void pulls.refresh(config.codeHost).then((decided) => {
		// A reflection's proposal was decided: merged retires the notes it covered; rejected keeps them.
		for (const pull of decided) {
			const day = pull.kind === "profile" ? threads.reflectionDay(pull.conversationId) : undefined;
			if (day !== undefined) memory.proposalDecided(day, pull.state === "merged");
		}
		// Mondays, after the reflection hour: how last week went.
		const today = new Date();
		if (today.getDay() !== 1 || today.getHours() < config.reflect.hour) return;
		const text = pulls.weeklyReport(weekOf(today));
		if (text !== undefined) announce(text);
	});
}, 5 * MINUTE);

/** Say something in Scout's home channel, if it has one. */
function announce(text: string): void {
	if (config.reflect.channel === undefined) return;
	slack.surface.post(config.reflect.channel, undefined, { text, blocks: [] }).catch((error: unknown) => {
		console.error("announcement failed:", error);
	});
}

// `kill -USR2 <pid>` reflects now, if today's reflection hasn't run yet.
process.on("SIGUSR2", () => void reflect(localDay(new Date())));

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		if (stopping) process.exit(1);
		stopping = true;
		clearInterval(tick);
		stopWatching();
		await slack.stop().catch(() => {});
		await harness.close(context);
		threads.close();
		pulls.close();
		search.close();
		memory.close();
		process.exit(0);
	});
}

function instanceId(dataDir: string): string {
	const path = join(dataDir, "instance");
	if (existsSync(path)) return readFileSync(path, "utf8").trim();
	const id = randomBytes(3).toString("hex");
	writeFileSync(path, `${id}\n`);
	return id;
}
