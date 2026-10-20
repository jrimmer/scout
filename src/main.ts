import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PullReviewer } from "./automation.ts";
import { hostname } from "node:os";
import { Bridge } from "./bridge.ts";
import { Collector } from "./dash/collect.ts";
import { startDashboard } from "./dash/server.ts";
import { ThreadDoc } from "./docs.ts";
import { Health } from "./health.ts";
import { loadConfig, useScoutsKey } from "./config.ts";
import { weekStart } from "./limits.ts";
import { applyRetention } from "./retention.ts";
import { resolveSecrets, rotate } from "./secrets.ts";
import { pullProfile } from "./profile.ts";
import { weekOf } from "./pulls.ts";
import { localDay } from "./reflect.ts";
import { openScout } from "./scout.ts";
import { Slack } from "./slack.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const context = BACKGROUND_CONTEXT;
// Secrets first: references (op://, file:, cred:, NAME_FILE) become values before anything reads them.
const secretSources = await resolveSecrets();
const config = loadConfig();
if (config.slack.botToken === "" || config.slack.appToken === "") {
	throw new Error("SLACK_BOT_TOKEN and SLACK_APP_TOKEN are not set (see .env.example)");
}
mkdirSync(config.dataDir, { recursive: true });
checkPi(config.dataDir, config.piMigrate);
useScoutsKey(config.git.sshKey);
console.log(`sandboxes: ${config.sandbox.driver}, image ${config.sandbox.image}, network ${config.sandbox.network}`);
if (config.sandbox.network === "none") {
	console.log("sandbox network: none. Installs and downloads will fail; set SCOUT_SANDBOX_NETWORK=open, or give repositories an egress list.");
}

const slack = new Slack(config.slack);
const health = new Health();
const startedAt = Date.now();
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
	groupMembers: (group) => slack.groupMembers(group),
});
const { harness, threads, pulls, memory, workspaces, reflector, audit } = scout;
const channelNames = new Map<number, string>();
async function channelOf(id: number): Promise<string> {
	let name = channelNames.get(id);
	if (name === undefined) {
		name = (await harness.snapshot(ThreadDoc, id as never, context))?.channelName || "?";
		channelNames.set(id, name);
	}
	return name;
}
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
	audit,
	admit: scout.admitter(async () => Promise.all(bridge.working().map(async (w) => ({ channel: await channelOf(w.conversationId) })))),
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
// The catalog prices its models; a gateway's own models cost nothing unless the prices file says otherwise.
for (const id of config.gateway?.models ?? []) {
	if (!scout.pricing.has(`gateway/${id}`)) console.log(`no price for gateway/${id}: budgets count it as free; set SCOUT_PRICES_FILE`);
}
console.log(`scout is listening as <@${slack.botUserId}> (model ${config.model.provider}/${config.model.modelId})`);

async function reflect(day: string): Promise<void> {
	if (reflector === undefined) return;
	const started = await health.watch("reflect", "the nightly reflection failed", () => reflector.run(day));
	if (started !== undefined) {
		console.log(`reflecting on ${started.threads} thread(s) for ${day}`);
		audit.record("reflection", { actor: "scout", conversationId: started.conversationId, detail: { day, threads: started.threads } });
	}
}

const tick = setInterval(() => {
	const now = Date.now();
	// Containers are cattle: stop the ones whose threads went quiet; the next tool call starts them again.
	for (const thread of threads.activeSince(now - 24 * HOUR)) {
		if (thread.lastActivity < now - HOUR && !bridge.view(thread.conversationId)?.busy) {
			void workspaces.suspend(thread.conversationId);
		}
	}
	if (config.profileRepo !== undefined) {
		void health.watch("profile", "pulling the profile failed", () => pullProfile(config.profileDir));
	}
	if (new Date(now).getHours() >= config.reflect.hour) void reflect(localDay(new Date(now)));
	if (pullReviewer !== undefined) void health.watch("reviews", "reviewing labelled pull requests failed", () => pullReviewer.poll());
	void health.watch("pulls", "checking pull requests failed", () => pulls.refresh(config.codeHost)).then(async (decided = []) => {
		// A reflection's proposal was decided: merged retires the notes it covered; rejected keeps them.
		for (const pull of decided) {
			audit.record("pull_decided", { actor: "code host", conversationId: pull.conversationId, detail: { url: pull.url, state: pull.state } });
			const day = pull.kind === "profile" ? threads.reflectionDay(pull.conversationId) : undefined;
			if (day !== undefined) memory.proposalDecided(day, pull.state === "merged");
		}
		// Mondays, after the reflection hour: how last week went.
		const today = new Date();
		if (today.getDay() !== 1 || today.getHours() < config.reflect.hour) return;
		const text = pulls.weeklyReport(weekOf(today), Date.now(), scout.spend.spent(0));
		if (text !== undefined) announce(text);
	});
	// What quiet threads leave behind, past the retention period.
	const retentionDays = config.governance.retentionDays;
	if (retentionDays !== undefined) {
		void health.watch("retention", "deleting old thread files failed", () =>
			applyRetention({ days: retentionDays, threads, workspaces, search: scout.search, memory, audit }),
		);
	}
}, 5 * MINUTE);

// `kill -HUP <pid>` reads secrets again. The code host token, the gateway key and spoond's token apply at once; Slack
// tokens and MCP servers' credentials need a restart.
process.on("SIGHUP", async () => {
	try {
		const changed = await rotate(secretSources);
		config.codeHost.token = process.env.SCOUT_CODEHOST_TOKEN ?? config.codeHost.token;
		if (config.gateway !== undefined && process.env.SCOUT_GATEWAY_KEY !== undefined) config.gateway.key = process.env.SCOUT_GATEWAY_KEY;
		console.log(changed.length === 0 ? "secrets: nothing changed" : `secrets rotated: ${changed.join(", ")}`);
		if (changed.some((name) => name.startsWith("SLACK_"))) console.log("Slack tokens changed: restart Scout to use them");
	} catch (error) {
		console.error("rotating secrets failed:", error);
	}
});

// The dashboard: read-only, on its own address (loopback unless it has a password).
const dashboard =
	config.dash === undefined
		? undefined
		: await startDashboard({
				addr: config.dash.addr,
				...(config.dash.auth === undefined ? {} : { auth: config.dash.auth }),
				collector: new Collector({
					host: hostname(),
					model: `${config.model.provider}/${config.model.modelId}`,
					startedAt,
					reflectHour: config.reflect.hour,
					profileRepo: config.profileRepo !== undefined,
					...(config.reviewLabel === undefined ? {} : { reviewLabel: config.reviewLabel }),
					threads,
					pulls,
					memory,
					working: () => bridge.working(),
					channelOf,
					spend: async () => scout.spend.byModel(0),
					week: () =>
						scout.spend.byChannel(weekStart(new Date())).map((c) => {
							const budget = scout.limits.budgetFor(c.channel);
							return { ...c, ...(budget === undefined ? {} : { budget }) };
						}),
					alerts: () => health.list(),
				}),
				metrics: {
					...(config.governance.metricsToken === undefined ? {} : { token: config.governance.metricsToken }),
					render: async () => {
						const working = bridge.working().length;
						return scout.counters.prometheus({
							scout_working_threads: { help: "Threads Scout is working in now.", value: working },
							scout_threads_last_day: { help: "Threads with activity in the last day.", value: threads.countSince(Date.now() - 24 * HOUR) },
							scout_open_pull_requests: { help: "Scout's pull requests still open.", value: pulls.count("kind = 'work' AND state = 'open'") },
							scout_unreviewed_notes: { help: "Notes not yet folded into the profile.", value: memory.active().length },
							scout_problems: { help: "Things that need a person (see the dashboard).", value: health.list().length },
							scout_spend_week_dollars: { help: "Model spend this week.", value: scout.spend.spent(weekStart(new Date())) },
							scout_sandbox_connections: { help: "Sandbox daemon connections open.", value: workspaces.connected },
						});
					},
				},
			});
if (config.dash !== undefined) console.log(`dashboard on http://${config.dash.addr}/`);

// `kill -USR2 <pid>` reflects now, if today's reflection hasn't run yet.
process.on("SIGUSR2", () => void reflect(localDay(new Date())));

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, async () => {
		if (stopping) process.exit(1);
		stopping = true;
		clearInterval(tick);
		await slack.stop().catch(() => {});
		await dashboard?.close();
		await scout.close();
		process.exit(0);
	});
}

/**
 * Pi Durable from main (`npm run pi -- main`) converts pi.sqlite to a schema its release can't open, so it does that
 * only when asked, and Scout on the release says why it can't open converted data instead of failing inside Pi.
 */
function checkPi(dataDir: string, migrate: boolean): void {
	const channel = new URL("../node_modules/.pi-channel", import.meta.url);
	const pi = existsSync(channel) ? readFileSync(channel, "utf8").trim() : "stable";
	console.log(`pi durable: ${pi}`);
	const db = join(dataDir, "pi.sqlite");
	const converted = join(dataDir, "pi-main");
	if (pi === "stable") {
		if (existsSync(converted)) {
			throw new Error(
				`${db} was converted by Pi Durable ${readFileSync(converted, "utf8").trim()}, which the release can't open. ` +
					"Go back with `npm run pi -- main`, or restore a backup from before the switch.",
			);
		}
		return;
	}
	if (existsSync(db) && !existsSync(converted) && !migrate) {
		throw new Error(
			`Pi Durable ${pi} converts ${db} for good: the release can't open it afterwards. Back it up (or use another ` +
				"SCOUT_DATA_DIR), then start once with SCOUT_PI_MIGRATE=1.",
		);
	}
	writeFileSync(converted, `${pi}\n`);
}

function instanceId(dataDir: string): string {
	const path = join(dataDir, "instance");
	if (existsSync(path)) return readFileSync(path, "utf8").trim();
	const id = randomBytes(3).toString("hex");
	writeFileSync(path, `${id}\n`);
	return id;
}
