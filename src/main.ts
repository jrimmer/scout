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
import { loadProfile, profileExtension, watchProfile } from "./profile.ts";
import { Workspaces } from "./sandbox.ts";
import { Slack } from "./slack.ts";
import { Threads } from "./threads.ts";

const HOUR = 60 * 60 * 1000;
const context = BACKGROUND_CONTEXT;
const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openaiProvider());

const threads = new Threads(join(config.dataDir, "scout.sqlite"));
const workspaces = new Workspaces({ ...config, instance: instanceId(config.dataDir) });
const slack = new Slack(config.slack);

const workspace = { base: config.repo.base, branch: (id: number) => workspaces.branch(id) };
const registry = createRegistry();
registry.install(profileExtension(loadProfile(config.profileDir), workspace));
registry.install(createCodingTools());
registry.install(
	createCodeHostExtension({
		...config,
		paths: (id) => workspaces.paths(id),
		branch: (id) => workspaces.branch(id),
		threadLink: async (id) => {
			const thread = threads.byConversation(id);
			return thread === undefined ? undefined : slack.permalink(thread.channel, thread.threadTs);
		},
		onPullRequest: (id, url) => threads.addPullRequest(id, url),
	}),
);
const stopWatching = watchProfile(config.profileDir, (profile) => {
	registry.install(profileExtension(profile, workspace));
	console.log("profile reloaded");
});

const harness = await Harness.open(
	await openNodeSqliteStorage(join(config.dataDir, "pi.sqlite")),
	{
		models,
		registry,
		env: ({ conversationId }) => workspaces.env(conversationId),
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

const bridge = new Bridge({
	harness,
	threads,
	surface: slack.surface,
	botUserId: await slack.identify(),
	nameOf: (user) => slack.nameOf(user),
	agent: { model: config.model },
	context,
	channelOffer: (user) => slack.channelOffer(user),
});

await bridge.reattach(Date.now() - 24 * HOUR);
harness.resume();
await slack.start({ onMessage: (message) => bridge.onMessage(message) });
console.log(`scout is listening as <@${slack.botUserId}> (model ${config.model.provider}/${config.model.modelId})`);

// Containers are cattle: stop the ones whose threads went quiet; the next tool call starts them again.
const reaper = setInterval(() => {
	const now = Date.now();
	for (const thread of threads.activeSince(now - 24 * HOUR)) {
		if (thread.lastActivity < now - HOUR && !bridge.view(thread.conversationId)?.busy) {
			void workspaces.stop(thread.conversationId);
		}
	}
}, 10 * 60 * 1000);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		if (stopping) process.exit(1);
		stopping = true;
		clearInterval(reaper);
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
