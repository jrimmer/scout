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
import { localDay, Reflector, reflectionExtensions } from "./reflect.ts";
import { Workspaces } from "./sandbox.ts";
import { Slack } from "./slack.ts";
import { Threads } from "./threads.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const context = BACKGROUND_CONTEXT;
const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openaiProvider());

const threads = new Threads(join(config.dataDir, "scout.sqlite"));
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
	onPullRequest: (id, url) => threads.addPullRequest(id, url),
});
registry.install(profileTools);
registry.install(codingTools);
registry.install(workCodeHost);

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
	onPullRequest: (_id, url) => {
		console.log(`reflection proposed ${url}`);
		if (config.reflect.channel === undefined) return;
		const text = `I went over yesterday's threads and wrote down what I learned. Could someone review it? ${url}`;
		slack.surface.post(config.reflect.channel, undefined, { text, blocks: [] }).catch((error: unknown) => {
			console.error("reflection announcement failed:", error);
		});
	},
});
registry.install(reflection.reflect);
registry.install(reflection.files);
registry.install(profileCodeHost);

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
		env: async (target, ctx) => (await reflector?.env(target, ctx)) ?? workspaces.env(target.conversationId),
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
		context,
		dataDir: config.dataDir,
		profileRepo: config.profileRepo,
		git: config.git,
		agent: { model: config.model, extensions: [reflection.reflect, reflection.files, profileCodeHost] },
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
	agent: { model: config.model, extensions: [profileTools, codingTools, workCodeHost] },
	context,
	channelOffer: (user) => slack.channelOffer(user),
});

await bridge.reattach(Date.now() - 24 * HOUR);
harness.resume();
await slack.start({ onMessage: (message) => bridge.onMessage(message) });
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
}, 5 * MINUTE);

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
