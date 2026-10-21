import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { type Alert, AlertLog, type AlertSource, AlertWatcher, gatusAlerts, grafanaAlerts } from "./alerts.ts";
import { PullReviewer } from "./automation.ts";
import { type Check, CiWatcher, MAX_FIXES } from "./ci.ts";
import { hostname } from "node:os";
import { Bridge } from "./bridge.ts";
import { Collector } from "./dash/collect.ts";
import { type Ask, forgeFor, Inbox } from "./forge.ts";
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
import { threadKey } from "./threads.ts";

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
	const home = config.reflect.channel;
	if (home === undefined) return;
	void slack
		.channelId(home)
		.then((id) => {
			if (id === undefined) throw new Error(`there's no channel #${home}`);
			return slack.surface.post(id, undefined, { text, blocks: [] });
		})
		.catch((error: unknown) => {
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
	// The announcement is the reflection's thread: replies there, and comments on the pull request, reach it (#34).
	reflectionProposed: (conversationId, text) => {
		const home = config.reflect.channel;
		if (home === undefined) return;
		void slack
			.channelId(home)
			.then(async (channel) => {
				if (channel === undefined) throw new Error(`there's no channel #${home}`);
				const threadTs = await slack.surface.post(channel, undefined, { text, blocks: [] });
				await bridge.adopt(conversationId, { channel, channelName: home, threadTs, about: text });
			})
			.catch((error: unknown) => console.error("announcing the reflection failed:", error));
	},
	// Threads start with someone's request, so in the channel nothing says which pull request came of which thread.
	pullOpened: (id, pull) => {
		const thread = scout.threads.byConversation(id);
		if (thread === undefined) return;
		slack
			.broadcast(thread.channel, thread.threadTs, `Opened <${pull.url}|${pull.slug}#${pull.number}>: ${pull.title.replace(/[&<>]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt" }[c]};`)}`)
			.catch((error: unknown) => console.error("pull request notice failed:", error));
	},
	groupMembers: (group) => slack.groupMembers(group),
	emailOf: (user) => slack.emailOf(user),
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

// Asked for a review in the code host, Scout reviews there, then says so in the repository's channel, where the thread
// knows the review and anyone can ask about it.
const VERDICTS = { approve: "approved", changes: "asked for changes on", comment: "commented on" } as const;
const pullReviewer = new PullReviewer({
	scout,
	config,
	context,
	onReview: async (posted) => {
		const channel = scout.channelOf(posted.repo)?.name;
		const id = channel === undefined ? undefined : await slack.channelId(channel);
		if (channel === undefined || id === undefined) return;
		const { review } = posted;
		const gist = review.body.split("\n\n")[0]?.slice(0, 600) ?? "";
		const lines = review.comments.length === 0 ? "" : ` (and ${review.comments.length} comment${review.comments.length === 1 ? "" : "s"} on lines)`;
		const text = [
			`I ${VERDICTS[review.verdict]} <${posted.url}|${posted.title}>${posted.author === undefined ? "" : ` by ${posted.author}`}${lines}.`,
			gist,
			"Reply in this thread to ask me about it, or to have me fix what I flagged.",
		]
			.filter(Boolean)
			.join("\n\n");
		const ts = await slack.surface.post(id, undefined, { text, blocks: [{ type: "markdown", text }] });
		const comments = review.comments.map((c) => `- ${c.path}:${c.line}: ${c.body}`).join("\n");
		await bridge.openThread({
			channel: id,
			channelName: channel,
			threadTs: ts,
			context: [
				`You reviewed pull request ${posted.url} ("${posted.title}"${posted.author === undefined ? "" : ` by ${posted.author}`}) at ${posted.sha.slice(0, 7)}, and ${VERDICTS[review.verdict]} it. Your review:`,
				review.body,
				...(comments === "" ? [] : [`Your comments on lines:\n${comments}`]),
				posted.head === undefined
					? "You started this thread to say so. People may ask about your review here. The pull request comes from a fork, so your sandbox has the repository's base branch, not its branch."
					: `You started this thread to say so. People may ask about your review here, or ask you to fix what you flagged. Your sandbox has the pull request's branch, ${posted.head}; a fix you open with open_pull_request goes into that branch, as a pull request its author can merge or not. Never push to their branch any other way.`,
			].join("\n\n"),
			...(posted.head === undefined ? {} : { base: posted.head }),
		});
	},
});

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
	approve: (conversationId, user) => scout.approvals.grant(conversationId, user),
	answered: (conversationId, ts, answer) => {
		scout.approvals.answered(conversationId, ts);
		const thread = threads.byConversation(conversationId);
		void (thread === undefined ? Promise.resolve(undefined) : slack.permalink(thread.channel, thread.threadTs))
			.then((link) => inbox.answered(conversationId, answer, link))
			.catch((error: unknown) => console.error("answering on the code host failed:", error));
	},
	costNote: (conversationId, since) => scout.limits.costNote(conversationId, since),
	approvalAskedIn: (ts) => scout.approvals.askedIn(ts),
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

// The alert responder: new alerts become public investigations in the channel that owns them (alerts.ts).
const alertSources: AlertSource[] = [
	...(config.alerts.gatusUrl === undefined ? [] : [{ source: "gatus" as const, read: () => gatusAlerts(config.alerts.gatusUrl!, fetch, scout.alertPolicy("gatus").downAfter) }]),
	...(config.alerts.grafana === undefined ? [] : [{ source: "grafana" as const, read: () => grafanaAlerts(config.alerts.grafana!.url, config.alerts.grafana!.token) }]),
];
const alertHome = config.alerts.channel ?? config.reflect.channel;
const alertLog = new AlertLog(join(config.dataDir, "scout.sqlite"));
const describeAlert = (alert: Alert) => `${alert.title}: ${alert.detail}${alert.url === undefined ? "" : ` (${alert.url})`}`;
const alertWatcher = new AlertWatcher({
	log: alertLog,
	sources: alertSources,
	policy: (source) => scout.alertPolicy(source),
	handlers: {
		firing: async (alert, investigate) => {
			const route = scout.alertChannel(alert);
			const name = route?.name ?? alertHome;
			const id = name === undefined ? undefined : await slack.channelId(name);
			if (name === undefined || id === undefined) {
				console.log(`alert with nowhere to go (no channel claims it, and no SCOUT_ALERTS_CHANNEL or SCOUT_REFLECT_CHANNEL): ${alert.title}`);
				return undefined;
			}
			const context = `${scout.responder()}\n\nThe alert, from ${alert.source}: ${describeAlert(alert)}\nIts labels: ${JSON.stringify(alert.labels)}`;
			if (!investigate) {
				// The profile's policy (responder.md) leaves this one alone; its thread is there if someone wants a look.
				const text = [`🟠 *${alert.title}*`, alert.detail, "Not one I look into on my own. Ask me in this thread if you'd like me to."].join("\n");
				const ts = await slack.surface.post(id, undefined, { text, blocks: [{ type: "markdown", text }] });
				await bridge.openThread({ channel: id, channelName: name, threadTs: ts, context: `${context}\n\nYou posted this alert without looking into it, as the policy says.`, about: describeAlert(alert) });
				audit.record("alert", { actor: "scout", channel: name, detail: { key: alert.key, title: alert.title, investigated: false } });
				return { channel: id, threadTs: ts };
			}
			const text = [`🔴 *${alert.title}*`, alert.detail, `${route?.oncall === undefined ? "" : `${route.oncall} `}I'm looking into it in this thread.`].join("\n");
			const ts = await slack.surface.post(id, undefined, { text, blocks: [{ type: "markdown", text }] });
			await bridge.investigate({
				channel: id,
				channelName: name,
				threadTs: ts,
				context,
				prompt: `This alert just fired in ${alert.source === "gatus" ? "Gatus" : "Grafana"}: ${describeAlert(alert)}. Look into it.`,
				requestId: `alert:${alert.key}:${Date.now()}`,
			});
			audit.record("alert", { actor: "scout", channel: name, detail: { key: alert.key, title: alert.title } });
			return { channel: id, threadTs: ts };
		},
		resolved: async (alert) => {
			if (alert.channel === undefined || alert.threadTs === undefined) return;
			const minutes = Math.max(1, Math.round((Date.now() - alert.openedAt) / MINUTE));
			await slack.surface.post(alert.channel, alert.threadTs, { text: `🟢 Resolved after ${minutes} min.`, blocks: [{ type: "markdown", text: `🟢 Resolved after ${minutes} min.` }] });
		},
		returned: async (alert) => {
			if (alert.channel === undefined || alert.threadTs === undefined) return;
			const text = `🔴 It's back (${alert.returns === 1 ? "once" : `${alert.returns} times`} since it first fired). Same incident, so I'm keeping it here rather than starting over; ask me if you want another look.`;
			await slack.surface.post(alert.channel, alert.threadTs, { text, blocks: [{ type: "markdown", text }] });
		},
		baseline: async (alerts) => {
			const id = alertHome === undefined ? undefined : await slack.channelId(alertHome);
			if (id === undefined) return;
			const names = alertSources.map((s) => (s.source === "gatus" ? "Gatus" : "Grafana")).join(" and ");
			const listed = alerts.slice(0, 15).map((a) => `• ${a.title}`);
			const text = [
				`I'm watching ${names} for alerts now. From here on, each new one gets a thread in the channel that owns it (or here), where I look into it.`,
				alerts.length === 0 ? "Nothing is firing right now." : `${alerts.length} already firing, which I'll leave be unless you ask:`,
				...listed,
				...(alerts.length > listed.length ? [`…and ${alerts.length - listed.length} more`] : []),
			].join("\n");
			await slack.surface.post(id, undefined, { text, blocks: [{ type: "markdown", text }] });
		},
	},
});
const alertTick =
	alertSources.length === 0
		? undefined
		: setInterval(() => void health.watch("alerts", "watching for alerts failed", () => alertWatcher.poll()), MINUTE);
if (alertSources.length > 0) console.log(`watching for alerts: ${alertSources.map((s) => s.source).join(", ")}`);

// CI on Scout's own pull requests: green says so in the thread, red goes back to the thread to fix (ci.ts).
const checkList = (checks: Check[]) => checks.map((c) => `• ${c.context}: ${c.state}${c.url === undefined ? "" : ` (${c.url})`}`).join("\n");
const inThread = async (conversationId: number, text: string) => {
	const thread = threads.byConversation(conversationId);
	if (thread !== undefined) await slack.surface.post(thread.channel, thread.threadTs, { text, blocks: [{ type: "markdown", text }] });
};
const ciWatcher = new CiWatcher({
	pulls,
	host: config.codeHost,
	handlers: {
		passed: (pull, sha) => inThread(pull.conversationId, `✅ CI passed on <${pull.url}|${pull.title}> at \`${sha.slice(0, 7)}\`.`),
		failed: async (pull, sha, checks, attempt) => {
			const prompt = [
				`CI failed on your pull request ${pull.url} (${pull.slug} #${pull.number}) at ${sha.slice(0, 7)}:`,
				checkList(checks),
				`Read the failing job's log with the CI tools (ci_runs, ci_jobs, ci_log for ${pull.slug}). If your change caused it, fix it in your workspace and call open_pull_request again, which pushes to the same pull request. If it isn't from your change (a flaky test, main already broken, the runner), say so and change nothing.`,
				`This is automatic attempt ${attempt} of ${MAX_FIXES}.`,
			].join("\n\n");
			await bridge.work(pull.conversationId, prompt, `ci:${pull.url}:${sha}`, "fix the build");
		},
		stuck: async (pull, sha) => {
			const asker = threads.byConversation(pull.conversationId)?.lastAsker;
			const who = !asker || asker === "scout" ? "Could someone" : `<@${asker}>, could you`;
			await inThread(pull.conversationId, `CI is still red on <${pull.url}|${pull.title}> at \`${sha.slice(0, 7)}\` after ${MAX_FIXES} tries at fixing it. ${who} take a look? I'll stop retrying.`);
		},
	},
});
const ciTick = setInterval(() => void health.watch("ci", "watching CI failed", () => ciWatcher.poll()), MINUTE);

// Scheduled work (schedules.ts): each schedule that's due starts a new thread in its channel, saying which one it is.
async function runSchedules(): Promise<void> {
	for (const s of scout.schedules.due()) {
		// Marked first, so a failure here doesn't start it again every minute.
		scout.schedules.ran(s.id);
		const channel = await slack.channelId(s.channel);
		if (channel === undefined) throw new Error(`schedule #${s.id}'s channel #${s.channel} is gone`);
		const root = `⏰ Schedule #${s.id}, ${s.when}: ${s.task}\nSet up by <@${s.createdBy}>. Anyone here can ask me to change, pause or stop it.`;
		const threadTs = await slack.surface.post(channel, undefined, { text: root, blocks: [{ type: "markdown", text: root }] });
		audit.record("schedule_ran", { actor: "scout", channel: s.channel, detail: { id: s.id, cron: s.cron } });
		await bridge.investigate({
			channel,
			channelName: s.channel,
			threadTs,
			context: `This thread was started by schedule #${s.id} (${s.when}, \`${s.cron}\`), set up by <@${s.createdBy}>. People can ask you here to change, pause or remove it.`,
			prompt: s.task,
			requestId: `schedule:${s.id}:${Math.floor(Date.now() / MINUTE)}`,
		});
	}
}
const scheduleTick = setInterval(() => void health.watch("schedules", "running scheduled work failed", runSchedules), MINUTE);

// Work asked on the code host: an issue assigned to Scout, @scout in an issue or a comment, and what people say on
// Scout's own pull requests (forge.ts). It goes to a thread like any request, and the answer back to the code host.
const forge = forgeFor(config.codeHost);
const inbox = new Inbox({
	path: join(config.dataDir, "scout.sqlite"),
	forge,
	handlers: {
		ownPull: (issue) => issue.pull && pulls.byNumber(issue.slug, issue.number) !== undefined,
		ask: (ask) => takeAsk(ask),
	},
});
const REVIEW_WORDS: Record<string, string> = { APPROVED: "approved", APPROVE: "approved", REQUEST_CHANGES: "asked for changes", CHANGES_REQUESTED: "asked for changes", COMMENT: "reviewed", COMMENTED: "reviewed" };
async function takeAsk(ask: Ask): Promise<void> {
	const { issue } = ask;
	const kind = issue.pull ? "pull request" : "issue";
	const ref = `${issue.slug}#${issue.number}`;
	const own = pulls.byNumber(issue.slug, issue.number);
	// A reflection's proposal is about the profile, which isn't a repository Scout works in, but people review it all the same.
	const profile = own?.kind === "profile" && config.profileRepo !== undefined ? { name: "profile", slug: config.profileRepo.slug } : undefined;
	const repo = profile ?? config.repos.find((r) => r.slug.toLowerCase() === issue.slug.toLowerCase());
	// Only answer when someone asked Scout directly; a remark on its pull request in a repository it no longer has isn't that.
	const say = (body: string) => (ask.why === "own pull request" ? Promise.resolve() : forge.comment(issue.slug, issue.number, body));
	if (repo === undefined) {
		await say(`I'm not set up to work in ${issue.slug}, so I can't take this on. Whoever runs me can add it.`);
		return;
	}
	const allowed = await scout.mayAsk(ask.by, repo);
	if (!allowed.ok) {
		await say(`@${ask.by} ${allowed.reason}`);
		return;
	}
	const said = ask.said.map((s) => `${s.author}${s.review === undefined ? "" : ` (${REVIEW_WORDS[s.review] ?? "reviewed"})`}: ${s.body.trim() || "(no comment)"}`).join("\n\n");
	const verb = ask.why === "assigned" ? `assigned you ${kind}` : ask.why === "mentioned" ? `asked you in ${kind}` : `commented on your ${kind}`;
	const prompt = [
		`${ask.by} ${verb} ${ref} "${issue.title}" on ${forge.name} (${issue.url}):`,
		said,
		ask.why === "own pull request"
			? "If they're asking for a change, make it and call open_pull_request again: it updates the same pull request. Otherwise answer them."
			: `Work on it as you would a request in Slack. Your answer goes in this thread and back on the ${kind} as a comment.${issue.pull ? "" : ` If you open a pull request that resolves the issue, put "Closes #${issue.number}" in its description.`}`,
	].join("\n\n");
	audit.record("request", { actor: ask.by, detail: { as: forge.name.toLowerCase(), url: issue.url, why: ask.why, text: said.slice(0, 200) } });
	const requestId = `forge:${ref}:${ask.said.map((s) => s.url ?? s.body.length).join(",")}`;

	// A thread it already has: the pull request Scout opened, or this issue's own.
	const existing = own?.conversationId ?? inbox.threadOf(issue.slug, issue.number);
	if (existing !== undefined && threads.byConversation(existing) !== undefined) {
		const quoted = ask.said.map((s) => `*${s.author}*${s.review === undefined ? "" : ` ${REVIEW_WORDS[s.review] ?? "reviewed"}`} on <${s.url ?? issue.url}|${ref}>:\n${quote(s.body)}`).join("\n\n");
		await inThread(existing, quoted);
		inbox.replyTo(existing, issue.slug, issue.number);
		await bridge.work(existing, prompt, requestId, "pick this up");
		return;
	}
	if (profile !== undefined) {
		await say("I can only revise this from the reflection that proposed it, and its thread is gone. I'll take this into account tonight.");
		return;
	}
	const name = scout.channelOf(repo.name)?.name ?? alertHome;
	const channel = name === undefined ? undefined : await slack.channelId(name);
	if (name === undefined || channel === undefined) {
		await say(`I don't have a Slack channel to work on ${repo.name} in yet, so I can't take this on. Whoever runs me can set one up.`);
		return;
	}
	const root = `📥 *${ask.by}* ${ask.why === "assigned" ? "assigned me" : "asked me on"} <${issue.url}|${ref}>: ${issue.title}\n${quote(ask.said.at(-1)?.body ?? "")}`;
	const threadTs = await slack.surface.post(channel, undefined, { text: root, blocks: [{ type: "markdown", text: root }] });
	const base = issue.pull ? await forge.headBranch(issue.slug, issue.number) : undefined;
	const context = [
		`This thread is for ${kind} ${ref} on ${forge.name}: ${issue.url}`,
		`# ${issue.title}\n\n${issue.body}`,
		...(base === undefined ? [] : [`Changes you make here go into the pull request's own branch, ${base}.`]),
	].join("\n\n");
	await bridge.investigate({ channel, channelName: name, threadTs, context, prompt, requestId, ...(base === undefined ? {} : { base }) });
	const conversationId = threads.get(threadKey(channel, threadTs))?.conversationId;
	if (conversationId !== undefined) {
		inbox.threadStarted(issue.slug, issue.number, conversationId);
		inbox.replyTo(conversationId, issue.slug, issue.number);
	}
	const link = await slack.permalink(channel, threadTs);
	await forge.comment(issue.slug, issue.number, `On it, in the open: ${link === undefined ? `#${name} in Slack` : `[#${name}](${link})`}. I'll answer here too.`);
}
function quote(text: string): string {
	const clipped = text.trim().length > 600 ? `${text.trim().slice(0, 599)}…` : text.trim();
	return clipped === "" ? "" : clipped.split("\n").map((line) => `> ${line}`).join("\n");
}
const inboxTick = setInterval(() => void health.watch("code host", "reading the code host's notifications failed", () => inbox.poll()), MINUTE);

/** Housekeeping every few minutes; also soon after a start, so a restart doesn't hold up reviews and retries. */
const housekeeping = () => {
	const now = Date.now();
	// Sandboxes are cattle: put to sleep the ones whose threads went quiet; the next tool call wakes them (a spoond lease
	// in under a second), so sleeping early costs little and leaves room for other threads.
	for (const thread of threads.activeSince(now - 24 * HOUR)) {
		if (thread.lastActivity < now - 15 * MINUTE && !bridge.view(thread.conversationId)?.busy) {
			void workspaces.suspend(thread.conversationId);
		}
	}
	if (config.profileRepo !== undefined) {
		void health.watch("profile", "pulling the profile failed", () => pullProfile(config.profileDir));
	}
	if (new Date(now).getHours() >= config.reflect.hour) void reflect(localDay(new Date(now)));
	void health.watch("reviews", "reviewing pull requests failed", () => pullReviewer.poll());
	void health.watch("images", "building repository images failed", async () => {
		for (const line of await scout.refreshImages()) console.log(line);
	});
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
};
const tick = setInterval(housekeeping, 5 * MINUTE);
const firstTick = setTimeout(housekeeping, 30_000);

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
					schedules: () => scout.schedules.all(),
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
		clearTimeout(firstTick);
		clearInterval(ciTick);
		clearInterval(inboxTick);
		clearInterval(scheduleTick);
		inbox.close();
		if (alertTick !== undefined) clearInterval(alertTick);
		alertLog.close();
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
