import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PullReviewer } from "./automation.ts";
import { Bridge } from "./bridge.ts";
import { loadConfig, useScoutsKey } from "./config.ts";
import { pullProfile } from "./profile.ts";
import { weekOf } from "./pulls.ts";
import { localDay } from "./reflect.ts";
import { openScout } from "./scout.ts";
import { Slack } from "./slack.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const context = BACKGROUND_CONTEXT;
const config = loadConfig();
if (config.slack.botToken === "" || config.slack.appToken === "") {
	throw new Error("SLACK_BOT_TOKEN and SLACK_APP_TOKEN are not set (see .env.example)");
}
mkdirSync(config.dataDir, { recursive: true });
useScoutsKey(config.git.sshKey);
if (config.sandbox.network === "none") {
	console.log("sandbox network: none. Installs and downloads will fail; set SCOUT_SANDBOX_NETWORK=bridge to allow them.");
}

const slack = new Slack(config.slack);
/** Say something in Scout's home channel, if it has one. */
function announce(text: string): void {
	if (config.reflect.channel === undefined) return;
	slack.surface.post(config.reflect.channel, undefined, { text, blocks: [] }).catch((error: unknown) => {
		console.error("announcement failed:", error);
	});
}

const scout = await openScout({
	config,
	storage: await openNodeSqliteStorage(join(config.dataDir, "pi.sqlite")),
	dataDir: config.dataDir,
	instance: instanceId(config.dataDir),
	context,
	link: async (id) => {
		const thread = scout.threads.byConversation(id);
		return thread === undefined ? undefined : slack.permalink(thread.channel, thread.threadTs);
	},
	threadLink: (thread) => slack.permalink(thread.channel, thread.threadTs),
	announce,
});
const { harness, threads, pulls, memory, workspaces, reflector } = scout;
harness.closed.then((end) => {
	if (end.reason === "failed") {
		console.error("harness failed; exiting so the supervisor restarts us:", end.error);
		process.exit(1);
	}
});
if (reflector === undefined) console.log("no SCOUT_PROFILE_REPO_URL: the nightly reflection is off");

const pullReviewer =
	config.reviewLabel === undefined
		? undefined
		: new PullReviewer({ scout, config, label: config.reviewLabel, context });

const bridge = new Bridge({
	harness,
	threads,
	surface: slack.surface,
	botUserId: await slack.identify(),
	nameOf: (user) => slack.nameOf(user),
	agent: scout.workAgent,
	context,
	channelOffer: (user) => slack.channelOffer(user),
	search: scout.search,
	repoFor: scout.repoFor,
	modelFor: scout.modelFor,
	download: (url) => slack.download(url),
	saveAttachment: (id, name, bytes) => workspaces.saveAttachment(id, name, bytes),
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
	void pullReviewer?.poll().catch((error: unknown) => console.error("pull request reviews failed:", error));
	void pulls.refresh(config.codeHost).then(async (decided) => {
		// A reflection's proposal was decided: merged retires the notes it covered; rejected keeps them.
		for (const pull of decided) {
			const day = pull.kind === "profile" ? threads.reflectionDay(pull.conversationId) : undefined;
			if (day !== undefined) memory.proposalDecided(day, pull.state === "merged");
		}
		// Mondays, after the reflection hour: how last week went.
		const today = new Date();
		if (today.getDay() !== 1 || today.getHours() < config.reflect.hour) return;
		const usage = await harness.usage(context);
		const spent = [...Object.values(usage.models), ...Object.values(usage.tools)].reduce((sum, u) => sum + (u.cost?.total ?? 0), 0);
		const text = pulls.weeklyReport(weekOf(today), Date.now(), spent);
		if (text !== undefined) announce(text);
	});
}, 5 * MINUTE);

// `kill -USR2 <pid>` reflects now, if today's reflection hasn't run yet.
process.on("SIGUSR2", () => void reflect(localDay(new Date())));

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		if (stopping) process.exit(1);
		stopping = true;
		clearInterval(tick);
		await slack.stop().catch(() => {});
		await scout.close();
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
