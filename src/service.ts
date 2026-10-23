import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import type { ConversationId, Storage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Receiver } from "@slack/bolt";
import { type Alert, AlertLog, type AlertSource, AlertWatcher, gatusAlerts, grafanaAlerts } from "./alerts.ts";
import { comparison } from "./approaches.ts";
import { PullReviewer } from "./automation.ts";
import { backupGauge, backupState, describeBackup, startNotice, weekLine as backupWeekLine } from "./backups.ts";
import { BenchStore, KEEP_RUNS } from "./bench.ts";
import { Bridge } from "./bridge.ts";
import { Capabilities } from "./capabilities.ts";
import { aboutHowLong, eventLoopLag, WAIT_KINDS } from "./capacity.ts";
import { type Check, CiWatcher, MAX_FIXES } from "./ci.ts";
import type { Config } from "./config.ts";
import { Collector } from "./dash/collect.ts";
import { startDashboard } from "./dash/server.ts";
import { ThreadDoc } from "./docs.ts";
import { countMcpTools, doctor, formatChecks, restartsOf, type Unit, unitOf } from "./doctor.ts";
import type { SandboxDriver } from "./drivers/types.ts";
import { allowInReposFile, EgressRequests } from "./egress.ts";
import { loadTasks } from "./evals.ts";
import { type Ask, askerOf, forgeFor, Inbox } from "./forge.ts";
import { modelsFor } from "./gateway.ts";
import { Health } from "./health.ts";
import { type HomeData, type HomeThread, homeView } from "./home.ts";
import { allows, describeInitiative } from "./initiative.ts";
import { weekStart } from "./limits.ts";
import type { McpConnection } from "./mcp.ts";
import { parseCodeLink, previewBlocks } from "./previews.ts";
import { pullProfile } from "./profile.ts";
import { weekOf } from "./pulls.ts";
import { asksSomething, Recaps } from "./recaps.ts";
import { localDay } from "./reflect.ts";
import type { ChatMessage } from "./render.ts";
import { applyRetention } from "./retention.ts";
import { openScout, sourceReader } from "./scout.ts";
import { APPROVE_BUTTON, DECLINE_BUTTON, EGRESS_ALLOW, EGRESS_DECLINE, Slack } from "./slack.ts";
import { refusedToken } from "./startup.ts";
import { threadKey } from "./threads.ts";
import { BranchCleanup, MAX_TRIES as UPKEEP_TRIES, PullUpkeep, ReviewNudges } from "./upkeep.ts";
import { ChannelCanvases, channelCanvas, channelWeeks, WeeklySummaries } from "./weekly.ts";
import { type WorkRow, WorkList } from "./worklist.ts";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const context = BACKGROUND_CONTEXT;

/**
 * What starting Scout can be given instead of the real thing. `main.ts` gives none of it but `config`, and adds the
 * process's signals; tests give fake Slack, a scripted model, their own clock, and turn the timers off to call `tick`.
 */
export type ServiceOptions = {
	config: Config;
	/** For tests: Slack's events from somewhere other than Socket Mode, and its Web API elsewhere (slack.ts). */
	slack?: { receiver?: Receiver; apiUrl?: string };
	/** Pi Durable's storage; by default pi.sqlite in the data directory. */
	storage?: Storage;
	/** Model access; by default as `openScout` makes it. */
	models?: Models;
	/** Where sandboxes run; by default the one the settings name. */
	driver?: SandboxDriver;
	/** MCP servers already connected; by default the ones in the MCP file. */
	mcp?: McpConnection[];
	/** Off to leave the profile directory unwatched. */
	watchProfile?: boolean;
	/** For the code host, alert sources, the directory and the doctor's checks; by default the global one. */
	fetch?: typeof fetch;
	/** The clock housekeeping goes by: the reflection hour, Mondays, working hours, how long things have been quiet. */
	now?: () => number;
	/** Off: nothing runs on a timer, and `tick` is the only way housekeeping, alerts, CI and the rest run. */
	timers?: boolean;
	/** Read secrets again (SIGHUP); returns the names of the ones that changed. */
	rotateSecrets?: () => Promise<string[]>;
	/** Ends the process: when the harness fails, and once a signal has stopped Scout. By default `process.exit`. */
	exit?: (code: number) => void;
};

export type Service = Awaited<ReturnType<typeof startService>>;
export type Signal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGUSR2";

/**
 * Scout as a service: Slack in front of `openScout`; the code host, alerts, CI, schedules and housekeeping behind it;
 * the dashboard beside it. Returns once Scout is listening.
 */
export async function startService(options: ServiceOptions) {
	const { config } = options;
	const clock = options.now ?? Date.now;
	const exit = options.exit ?? ((code: number) => process.exit(code));
	const doFetch = options.fetch ?? fetch;
	const timers: ReturnType<typeof setInterval>[] = [];
	/** `work` every `ms`, unless timers are off; `close` stops it. */
	const every = (ms: number, work: () => void): ReturnType<typeof setInterval> | undefined => {
		if (options.timers === false) return undefined;
		const timer = setInterval(work, ms);
		timers.push(timer);
		return timer;
	};

	const slack = new Slack(config.slack, options.slack);
	const health = new Health();
	const startedAt = clock();
	/** Since when Scout has been draining for a restart (SIGINT, below), if it is. */
	let draining: number | undefined;
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
		storage: options.storage ?? (await openNodeSqliteStorage(join(config.dataDir, "pi.sqlite"))),
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
			void (async () => {
				// Reviews from whoever owns what it touches, and whoever asked for it, so it doesn't wait to be noticed.
				const asked = await askForReviews(pull, thread.lastAsker).catch((error: unknown) => {
					console.error(`requesting reviews on ${pull.url} failed:`, error);
					return [];
				});
				const title = pull.title.replace(/[&<>]/g, (c) => `&${{ "&": "amp", "<": "lt", ">": "gt" }[c]};`);
				const reviewers = asked.length === 0 ? "" : ` · review requested from ${asked.join(", ")}`;
				await slack.broadcast(thread.channel, thread.threadTs, `Opened <${pull.url}|${pull.slug}#${pull.number}>: ${title}${reviewers}`);
				await track(id, { state: "Pull request open", pull: { url: pull.url, label: `${pull.slug}#${pull.number}` } });
			})().catch((error: unknown) => console.error("pull request notice failed:", error));
		},
		groupMembers: (group) => slack.groupMembers(group),
		emailOf: (user) => slack.emailOf(user),
		...(options.models === undefined ? {} : { models: options.models }),
		...(options.driver === undefined ? {} : { driver: options.driver }),
		...(options.mcp === undefined ? {} : { mcp: options.mcp }),
		...(options.watchProfile === undefined ? {} : { watchProfile: options.watchProfile }),
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
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
			exit(1);
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
		fetch: doFetch,
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
			// A later @scout on that pull request goes to this thread.
			const reviewThread = threads.get(threadKey(id, ts))?.conversationId;
			if (reviewThread !== undefined) inbox.threadStarted(posted.slug, posted.number, reviewThread);
		},
	});

	// What this Slack workspace lets Scout do (capabilities.ts): learned from the app's scopes now, and from the first
	// real call for features a plan may not include. Logged once at start, and whenever one turns out to be off.
	const capabilities = new Capabilities(join(config.dataDir, "scout.sqlite"));

	// Work an answer sets off after its run (copying it back to the code host): closing waits for it, so a stop or a
	// drain right after an answer doesn't lose the copy.
	const afterAnswers = new Set<Promise<unknown>>();
	const finishing = (work: Promise<unknown>) => {
		afterAnswers.add(work);
		void work.finally(() => afterAnswers.delete(work));
	};

	const bridge = new Bridge({
		harness,
		threads,
		surface: slack.surface,
		botUserId: await slack.identify().catch((error: unknown) => {
			throw refusedToken(error, "SLACK_BOT_TOKEN");
		}),
		nameOf: (user) => slack.nameOf(user),
		agent: scout.workAgent,
		context,
		channelOffer: (user) => slack.channelOffer(user),
		search: scout.search,
		repoFor: scout.repoFor,
		approve: (conversationId, user) => scout.approvals.grant(conversationId, user),
		reactionsOn: () => capabilities.on("reactions"),
		reactionPhases: () => config.statusReactions,
		reactionEmoji: (phase) => scout.reactionEmoji(phase),
		runStarted: (conversationId) => void track(conversationId, { state: "Working" }),
		answered: (conversationId, ts, answer, outcome) => {
			scout.approvals.answered(conversationId, ts);
			recaps.answered(conversationId, answer);
			const thread = threads.byConversation(conversationId);
			// A change waiting for approval: Approve and Decline buttons, beside the 👍 that also works.
			if (thread !== undefined && scout.approvals.waiting(conversationId)) void askForApproval(conversationId, thread.channel, thread.threadTs);
			const state = outcome === "problem" ? "Ran into a problem" : answer !== undefined && asksSomething(answer) ? "Waiting on someone" : "Answered";
			void track(conversationId, { state, cost: scout.spend.spentOn(conversationId, 0).cost });
			finishing(
				(thread === undefined ? Promise.resolve(undefined) : slack.permalink(thread.channel, thread.threadTs))
					.then((link) => inbox.answered(conversationId, answer, link))
					.catch((error: unknown) => console.error("answering on the code host failed:", error)),
			);
		},
		costNote: (conversationId, since) => scout.limits.costNote(conversationId, since),
		approvalAskedIn: (ts) => scout.approvals.askedIn(ts),
		audit,
		admit: scout.admitter(() => runsNow()),
		queueEta: (place) => {
			const range = scout.capacity.eta(place, config.capacity.maxRuns);
			return range === undefined ? undefined : aboutHowLong(range);
		},
		waited: (kind, ms) => scout.capacity.waited(kind, ms),
		ran: (ms) => scout.capacity.ran(ms),
		waitingFor: (conversationId) => scout.waitingFor(conversationId),
		...(scout.breakers === undefined ? {} : { fallbackNotice: (conversationId: number) => scout.fallbackNotice(conversationId) }),
		modelFor: scout.modelFor,
		download: (url, limit) => slack.download(url, limit),
		saveAttachment: (id, name, bytes) => workspaces.saveAttachment(id, name, bytes),
	});

	await bridge.reattach(Date.now() - 24 * HOUR);
	harness.resume();
	await slack.start({
		onMessage: (message) => bridge.onMessage(message),
		onReaction: (reaction) => bridge.onReaction(reaction),
		onEdit: (edit) => bridge.onEdit(edit),
		onDelete: (deleted) => bridge.onDelete(deleted),
		home: (user) => homeFor(user),
		// "Ask Scout about this": a thread on that message, started as if they'd asked there (admitted and audited).
		onAsk: async (ask) => {
			await startOn({ ...ask, threadTs: ask.threadTs ?? ask.ts, intro: `<@${ask.user}> asked me about this: ${ask.request}` });
		},
		onLook: async (look) => {
			await startOn({ ...look, threadTs: look.threadTs ?? look.ts, request: "Look into this.", intro: `<@${look.user}> asked me to look into this.` });
		},
		onDecision: (decision) => decide(decision),
		onUseApproach: (use) => useApproach(use),
		onEgress: (decision) => decideEgress(decision),
		onCommand: (command) => slashCommand(command),
		onLinks: (links) => previews(links),
		onWorkflowAsk: async (ask) => {
			const info = await slack.app.client.conversations.info({ channel: ask.channel }).catch(() => undefined);
			if (info?.channel?.is_channel !== true || info.channel.is_private === true || info.channel.is_member !== true) {
				throw new Error("Ask Scout works in public channels Scout is in. Invite Scout to the channel first.");
			}
			const intro = `<@${ask.user}>, through a workflow, asked me: ${ask.request}`;
			const threadTs = await startOn({ channel: ask.channel, channelName: info.channel.name ?? ask.channel, user: ask.user, request: ask.request, text: ask.about ?? "", intro });
			return slack.permalink(ask.channel, threadTs);
		},
	}).catch((error: unknown) => {
		throw refusedToken(error, "SLACK_APP_TOKEN");
	});
	// How much Scout does on its own: in the log at every start, and in its home channel the first time on each level.
	console.log(describeInitiative(config.initiative));
	{
		const told = join(config.dataDir, "initiative-told");
		if (!existsSync(told) || readFileSync(told, "utf8").trim() !== config.initiative) {
			announce(describeInitiative(config.initiative));
			writeFileSync(told, config.initiative);
		}
	}
	capabilities.granted(slack.scopes);
	for (const line of capabilities.summary()) console.log(line);
	audit.record("capabilities", { actor: "scout", detail: { scopes: slack.scopes, off: Object.fromEntries((["attachments", "emails", "reactions", "shortcuts", "unfurls", "canvases", "lists", "workflowSteps"] as const).flatMap((f) => { const why = capabilities.off(f); return why === undefined ? [] : [[f, why]]; })) } });

	/**
	 * A thread started for someone from outside a conversation (a shortcut, 🔍, /scout ask, a workflow): a message saying
	 * who asked, then their request, as if they'd mentioned Scout there, so it's admitted and audited the same way.
	 * Returns the thread's timestamp.
	 */
	async function startOn(start: { channel: string; channelName: string; user: string; request: string; text: string; author?: string; threadTs?: string; intro: string }): Promise<string> {
		const posted = await slack.surface.post(start.channel, start.threadTs, { text: start.intro, blocks: [{ type: "markdown", text: start.intro }] });
		const threadTs = start.threadTs ?? posted;
		const about =
			start.text === "" ? "" : `\n\nAbout ${start.author === undefined ? "this" : `<@${start.author}>'s message`}:\n${start.text.split("\n").map((l) => `> ${l}`).join("\n")}`;
		await bridge.onMessage({ channel: start.channel, channelType: "channel", channelName: start.channelName, user: start.user, text: `<@${slack.botUserId}> ${start.request}${about}`, ts: posted, threadTs });
		return threadTs;
	}

	// A sandbox that couldn't reach a host: ask the people who decide, in the home channel (egress.ts).
	const egress = new EgressRequests(join(config.dataDir, "scout.sqlite"));
	scout.setEgress(async (conversationId, host, why) => {
		const name = scout.workspaces.repo((await scout.repoOfConversation(conversationId)).name).name;
		const repo = config.repos.find((r) => r.name === name);
		if (repo === undefined) return "I couldn't tell which repository this thread works in, so I can't ask for its network.";
		if (repo.egress?.includes(host) === true) {
			return `${host} is already allowed for ${repo.name}. This thread's sandbox may have started before it was; a new thread gets it.`;
		}
		if (repo.egress === undefined && config.sandbox.network === "open") {
			return `Sandboxes for ${repo.name} already have an open network, so it isn't the egress list: ${host} may be down, or blocking us.`;
		}
		const { request, isNew } = egress.ask({ repo: repo.name, host, why, conversationId });
		if (!isNew) return `I've already asked for ${host} to be allowed for ${repo.name}; it's waiting on a decision.`;
		audit.record("egress_requested", { actor: "scout", conversationId, detail: { id: request.id, repo: repo.name, host, why } });
		const home = config.reflect.channel === undefined ? undefined : await slack.channelId(config.reflect.channel);
		if (home === undefined) return `I'd ask for ${host} to be allowed for ${repo.name}, but I have no home channel to ask in. Whoever runs me can add it to the repository's egress list.`;
		const link = await linkOf(conversationId);
		const text = `${link === undefined ? "A thread" : `<${link}|A thread>`} in *${repo.name}* couldn't reach \`${host}\`: ${why}\nAllow \`${host}\` for ${repo.name}'s sandboxes?`;
		await slack.surface.post(home, undefined, {
			text,
			blocks: [
				{ type: "section", text: { type: "mrkdwn", text } },
				{
					type: "actions",
					elements: [
						{ type: "button", action_id: EGRESS_ALLOW, text: { type: "plain_text", text: "Allow" }, style: "primary", value: String(request.id) },
						{ type: "button", action_id: EGRESS_DECLINE, text: { type: "plain_text", text: "Decline" }, value: String(request.id) },
					],
				},
			],
		});
		return `I've asked whoever runs me to allow ${host} for ${repo.name}'s sandboxes. I'll say here when they decide.`;
	});

	/** Allow or Decline on a network request: only the egress approvers decide; the thread hears the outcome. */
	async function decideEgress(d: { user: string; id: number; allow: boolean }): Promise<{ text: string; final: boolean }> {
		const request = egress.get(d.id);
		if (request === undefined) return { text: "That request is gone.", final: true };
		if (request.state !== "pending") return { text: `Already ${request.state}${request.decidedBy === undefined ? "" : ` by <@${request.decidedBy}>`}.`, final: true };
		const refused = await scout.refuseApprover(d.user, "egress");
		if (refused !== undefined) return { text: `You can't decide this one: ${refused}`, final: false };
		const decided = egress.decide(d.id, d.allow, d.user);
		if (decided === undefined) return { text: "Someone else just decided it.", final: true };
		const repo = config.repos.find((r) => r.name === decided.repo);
		let where = "";
		if (d.allow && repo !== undefined) {
			// New sandboxes get it now; the repos file keeps it across restarts, when the repository is in it.
			if (repo.egress?.includes(decided.host) !== true) repo.egress = [...(repo.egress ?? []), decided.host];
			const saved = config.reposFile !== undefined && allowInReposFile(config.reposFile, repo.name, decided.host);
			where = saved ? " (saved to the repos file)" : ` (until I restart: ${repo.name} isn't in the repos file, so add it to SCOUT_REPO_EGRESS to keep it)`;
		}
		audit.record("egress_decided", { actor: d.user, conversationId: decided.conversationId, detail: { id: d.id, repo: decided.repo, host: decided.host, allowed: d.allow } });
		const toThread = d.allow
			? `<@${d.user}> allowed \`${decided.host}\` for ${decided.repo}'s sandboxes. New sandboxes get it; this thread's started without it, so a new thread (or a fresh sandbox) is where it works.`
			: `<@${d.user}> declined \`${decided.host}\` for ${decided.repo}'s sandboxes, so I'll have to do without it.`;
		await inThread(decided.conversationId, toThread).catch(() => {});
		await bridge.note(decided.conversationId, toThread.replace(/<@(\w+)>/g, "someone"), `egress:${d.id}`).catch(() => {});
		return { text: `${d.allow ? "✅ Allowed" : "✋ Declined"} by <@${d.user}>: \`${decided.host}\` for ${decided.repo}${where}.`, final: true };
	}

	// Experimental: a thread's comparison of approaches lives in one message in it (approaches.ts).
	scout.setApproachesView(async (parentId, message, ts) => {
		const thread = threads.byConversation(parentId);
		if (thread === undefined) return undefined;
		if (ts !== undefined) {
			await slack.surface.update(thread.channel, ts, message);
			return ts;
		}
		return slack.surface.post(thread.channel, thread.threadTs, message);
	});

	/** Someone chose one of a thread's approaches: checked like any request from them, then onto the thread's branch. */
	async function useApproach(use: { user: string; channel: string; parentId: number; index: number }): Promise<ChatMessage | string> {
		const thread = threads.byConversation(use.parentId);
		if (thread === undefined) return "That thread is gone.";
		const doc = await harness.snapshot(ThreadDoc, use.parentId as ConversationId, context);
		const channelName = doc?.channelName ?? "";
		const allowed = await scout.admitter(async () => [])({ user: use.user, channelName, ...(doc?.repo === undefined ? {} : { repo: doc.repo }), starting: false });
		if (!allowed.ok) return allowed.reason;
		let chosen;
		try {
			chosen = await scout.chooseApproach(use.parentId, use.index, use.user);
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
		audit.record("approved", { actor: use.user, conversationId: use.parentId, channel: channelName, detail: { approach: chosen.index, name: chosen.name } });
		const said = `<@${use.user}> chose approach ${chosen.index}, *${chosen.name}*. Its commits are on this thread's branch now; ask me to open the pull request when you're ready.`;
		await inThread(use.parentId, said);
		await bridge.note(use.parentId, `${await slack.nameOf(use.user)} chose approach ${chosen.index} (${chosen.name}); its commits are now on your branch, and the other approaches are gone.`, `approach-chosen:${use.parentId}:${chosen.index}`);
		return comparison(scout.approaches.forThread(use.parentId), Date.now(), () => 0, true);
	}

	/** Approve and Decline buttons in the thread, for the change Scout just asked approval for. */
	async function askForApproval(conversationId: number, channel: string, threadTs: string): Promise<void> {
		const text = "This change needs someone's approval before I make it.";
		await slack.surface
			.post(channel, threadTs, {
				text,
				blocks: [
					{ type: "section", text: { type: "mrkdwn", text: `${text} (👍 on my answer works too.)` } },
					{
						type: "actions",
						elements: [
							{ type: "button", action_id: APPROVE_BUTTON, text: { type: "plain_text", text: "Approve" }, style: "primary", value: String(conversationId) },
							{ type: "button", action_id: DECLINE_BUTTON, text: { type: "plain_text", text: "Decline" }, style: "danger", value: String(conversationId) },
						],
					},
				],
			})
			.catch((error: unknown) => console.error("posting approval buttons failed:", error));
	}

	/** Someone pressed Approve or Decline: through the same checks as a reply, and the buttons give way to who decided. */
	async function decide(d: { user: string; channel: string; conversationId: number; approve: boolean }): Promise<string> {
		const thread = threads.byConversation(d.conversationId);
		if (thread === undefined) return "That thread is gone.";
		if (!scout.approvals.waiting(d.conversationId)) return "Nothing's waiting for approval there any more.";
		const channelName = await channelOf(d.conversationId);
		const ts = (Date.now() / 1000).toFixed(6);
		if (d.approve) {
			// Only the approvers for the waiting change: anyone else's press doesn't count, and the button stays.
			const server = scout.approvals.askedFor(d.conversationId);
			const refused = server === undefined ? undefined : await scout.refuseApprover(d.user, server);
			if (refused !== undefined) return `<@${d.user}> can't approve this one: ${refused}`;
			await bridge.onMessage({ channel: thread.channel, channelType: "channel", channelName, user: d.user, text: "approve", ts, threadTs: thread.threadTs });
			return scout.approvals.by(d.conversationId) === d.user ? `👍 Approved by <@${d.user}>.` : `<@${d.user}> can't approve this one; the thread says why.`;
		}
		scout.approvals.answered(d.conversationId, undefined);
		await bridge.onMessage({ channel: thread.channel, channelType: "channel", channelName, user: d.user, text: `<@${slack.botUserId}> I'm declining that change: please don't make it.`, ts, threadTs: thread.threadTs });
		return `✋ Declined by <@${d.user}>.`;
	}

	/** `/scout …`, answered just to whoever asked. */
	async function slashCommand(c: { user: string; channel: string; channelName: string; text: string }): Promise<string> {
		const [word = "", ...rest] = c.text.trim().split(/\s+/);
		const command = word.toLowerCase();
		// The doctor shows how I'm set up (addresses, accounts, what's broken) and costs a model call: admins only.
		if (command === "doctor" && !(await scout.isAdmin(c.user))) {
			return "Only my admins can run the doctor from Slack, since it shows how I'm set up. Whoever runs me can run `npm run doctor` on my host.";
		}
		// The rest show or start work in this channel's repository: for people who may ask for work there.
		if (command === "status" || command === "waiting" || command === "schedules" || command === "ask") {
			const allowed = await scout.mayAskIn(c.user, c.channelName);
			if (!allowed.ok) return allowed.reason;
		}
		// Work happens where everyone can see it: never in a private channel or a DM, whose content would then reach
		// threads and search. The same check as the Workflow step's.
		if (command === "ask") {
			const info = await slack.app.client.conversations.info({ channel: c.channel }).catch(() => undefined);
			if (info?.channel?.is_channel !== true || info.channel.is_private === true || info.channel.is_member !== true) {
				return "I only take work in public channels I'm in, so everyone can see what we do. Invite me to one and ask there.";
			}
		}
		switch (command) {
			case "status":
				return describeNow(c.channelName);
			case "doctor": {
				const mcpFile = config.mcpFile;
				const directory = config.governance.directory;
				return formatChecks(
					await doctor(config, {
						models: options.models ?? modelsFor(config.gateway),
						fetch: doFetch,
						...(mcpFile === undefined ? {} : { mcp: () => countMcpTools(mcpFile) }),
						...(directory === undefined ? {} : { directory: sourceReader(directory.source, config.codeHost, doFetch) }),
						running: () => collector.collect(),
						restarts: () => restartsOf(ownUnit()),
					}),
				);
			}
			case "schedules": {
				const here = scout.schedules.forChannel(c.channelName);
				return here.length === 0 ? "No schedules in this channel. Ask me in a thread for recurring work." : here.map((s) => `#${s.id}: ${s.when}, ${s.task}${s.paused ? " (paused)" : ""}`).join("\n");
			}
			case "waiting": {
				const home = await homeData(c.user);
				return home.waitingOnYou.length === 0 ? "Nothing's waiting on you." : home.waitingOnYou.map((w) => `• ${w.link === undefined ? `#${w.channel}` : `<${w.link}|#${w.channel}>`}: ${w.what}`).join("\n");
			}
			case "ask": {
				const request = rest.join(" ").trim();
				if (request === "") return "What should I do? `/scout ask fix the flaky login test`";
				const threadTs = await startOn({ channel: c.channel, channelName: c.channelName, user: c.user, request, text: "", intro: `<@${c.user}> asked me: ${request}` });
				const link = await slack.permalink(c.channel, threadTs);
				return `On it${link === undefined ? "." : `: <${link}|the thread>.`}`;
			}
			default:
				return ["`/scout status`: what I'm doing right now", "`/scout doctor`: whether everything I depend on is set up right", "`/scout schedules`: this channel's schedules", "`/scout waiting`: what's waiting on you", "`/scout ask …`: start a thread with a request"].join("\n");
		}
	}

	/** Previews for pasted links to pull requests and issues in repositories Scout works in. */
	async function previews(links: string[]): Promise<Record<string, { blocks: unknown[] }>> {
		const out: Record<string, { blocks: unknown[] }> = {};
		if (!capabilities.on("unfurls") || !allows(config.initiative, "team")) return out;
		for (const url of links.slice(0, 5)) {
			const link = parseCodeLink(url);
			if (link === undefined || !config.repos.some((r) => r.slug.toLowerCase() === link.slug.toLowerCase())) continue;
			const issue = await forge.issue(link.slug, link.number).catch(() => undefined);
			if (issue === undefined) continue;
			const status = issue.pull ? await forge.pullStatus(link.slug, link.number).catch(() => undefined) : undefined;
			const ci = status === undefined ? undefined : await forge.ciState(link.slug, status.head).catch(() => undefined);
			const conversation = pulls.byNumber(link.slug, link.number)?.conversationId ?? inbox.threadOf(link.slug, link.number);
			const thread = conversation === undefined ? undefined : await linkOf(conversation);
			out[url] = {
				blocks: previewBlocks({
					url,
					slug: link.slug,
					number: link.number,
					title: issue.title,
					pull: issue.pull,
					state: status?.merged === true ? "merged" : issue.state === "open" ? "open" : "closed",
					author: issue.author,
					...(ci === undefined ? {} : { ci }),
					reviewers: status?.reviewers ?? [],
					...(conversation === undefined ? {} : { scout: { ...(thread === undefined ? {} : { link: thread }), working: bridge.view(conversation)?.busy === true } }),
				}),
			};
		}
		return out;
	}
	// What people said while Scout was down: Socket Mode doesn't replay it, so read it back and take it in, in order.
	// Each request is keyed by its message, so one Scout had already handled isn't handled twice.
	const alive = join(config.dataDir, "alive");
	const lastAlive = existsSync(alive) ? Number(readFileSync(alive, "utf8")) : NaN;
	let caughtUp = Promise.resolve();
	if (Number.isFinite(lastAlive)) {
		const since = Math.max(lastAlive - 2 * MINUTE, Date.now() - 6 * HOUR);
		const active = threads.activeSince(Date.now() - 7 * 24 * HOUR).slice(0, 100);
		caughtUp = slack
			.missed(since, active)
			.then(async (missed) => {
				if (missed.length > 0) console.log(`catching up on ${missed.length} message${missed.length === 1 ? "" : "s"} from while I was away`);
				for (const message of missed) await bridge.onMessage(message);
			})
			.catch((error: unknown) => console.error("catching up on missed messages failed:", error));
	}
	const heartbeat = () => writeFileSync(alive, String(Date.now()));
	every(MINUTE, heartbeat);
	heartbeat();

	// Whether the data is backed up off this machine (backups.ts), for the dashboard, /metrics and the doctor; and once a
	// start, after Litestream starting alongside has had its grace, a word in the home channel if it isn't.
	let backup = backupState(config.dataDir, config.backup);
	if (backup.status !== "ok") console.log(describeBackup(backup));
	let backupTold = false;
	const backupTick = () => {
		backup = backupState(config.dataDir, config.backup);
		const notice = backupTold || !allows(config.initiative, "own") ? undefined : startNotice(backup, startedAt, clock());
		if (notice === undefined) return;
		backupTold = true;
		announce(notice);
	};
	every(MINUTE, backupTick);
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
		...(config.alerts.gatusUrl === undefined ? [] : [{ source: "gatus" as const, read: () => gatusAlerts(config.alerts.gatusUrl!, doFetch, scout.alertPolicy("gatus").downAfter) }]),
		...(config.alerts.grafana === undefined ? [] : [{ source: "grafana" as const, read: () => grafanaAlerts(config.alerts.grafana!.url, config.alerts.grafana!.token, doFetch) }]),
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
				const minutes = Math.max(1, Math.round((clock() - alert.openedAt) / MINUTE));
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
	const watchingAlerts = alertSources.length > 0 && allows(config.initiative, "team");
	const alertTick = async () => {
		if (watchingAlerts) await health.watch("alerts", "watching for alerts failed", () => alertWatcher.poll(clock()));
	};
	if (watchingAlerts) every(MINUTE, () => void alertTick());
	if (watchingAlerts) console.log(`watching for alerts: ${alertSources.map((s) => s.source).join(", ")}`);
	else if (alertSources.length > 0) console.log(`not watching for alerts: initiative is ${config.initiative} (team watches them)`);

	// CI on Scout's own pull requests: green says so in the thread, red goes back to the thread to fix (ci.ts).
	const checkList = (checks: Check[]) => checks.map((c) => `• ${c.context}: ${c.state}${c.url === undefined ? "" : ` (${c.url})`}`).join("\n");
	const inThread = async (conversationId: number, text: string) => {
		const thread = threads.byConversation(conversationId);
		if (thread !== undefined) await slack.surface.post(thread.channel, thread.threadTs, { text, blocks: [{ type: "markdown", text }] });
	};
	const ciWatcher = new CiWatcher({
		pulls,
		host: config.codeHost,
		fetch: doFetch,
		handlers: {
			passed: async (pull, sha) => {
				await inThread(pull.conversationId, `✅ CI passed on <${pull.url}|${pull.title}> at \`${sha.slice(0, 7)}\`.`);
				await track(pull.conversationId, { ci: "Passing" });
			},
			failed: async (pull, sha, checks, attempt) => {
				void track(pull.conversationId, { ci: "Failing" });
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
	// Runs that haven't moved on for a while say so; ones stuck far too long stop with a summary (render.ts).
	// What each run is waiting on (a sandbox, the model) shows in its progress message, kept current.
	const waitsTick = () => bridge.refreshWaits().catch((error: unknown) => console.error("showing waits failed:", error));
	every(3_000, () => void waitsTick())?.unref();
	const watchdog = () => health.watch("watchdog", "watching for stuck runs failed", () => bridge.watch(clock()));
	every(MINUTE, () => void watchdog());
	const ciTick = async () => {
		if (allows(config.initiative, "own")) await health.watch("ci", "watching CI failed", () => ciWatcher.poll(clock()));
	};
	every(MINUTE, () => void ciTick());

	// Scheduled work (schedules.ts): each schedule that's due starts a new thread in its channel, saying which one it is.
	async function runSchedules(): Promise<void> {
		for (const s of scout.schedules.due(clock())) {
			// Marked first, so a failure here doesn't start it again every minute.
			scout.schedules.ran(s.id, clock());
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
				requestId: `schedule:${s.id}:${Math.floor(clock() / MINUTE)}`,
			});
		}
	}
	const scheduleTick = () => health.watch("schedules", "running scheduled work failed", runSchedules);
	every(MINUTE, () => void scheduleTick());

	// Work asked on the code host: an issue assigned to Scout, @scout in an issue or a comment, and what people say on
	// Scout's own pull requests (forge.ts). It goes to a thread like any request, and the answer back to the code host.
	const forge = forgeFor(config.codeHost, doFetch);
	const inbox = new Inbox({
		path: join(config.dataDir, "scout.sqlite"),
		forge,
		handlers: {
			ownPull: (issue) => issue.pull && pulls.byNumber(issue.slug, issue.number) !== undefined,
			ask: (ask) => takeAsk(ask),
		},
	});
	scout.setCodeHostAskers((thread) => inbox.askers(thread.key));
	const REVIEW_WORDS: Record<string, string> = { APPROVED: "approved", APPROVE: "approved", REQUEST_CHANGES: "asked for changes", CHANGES_REQUESTED: "asked for changes", COMMENT: "reviewed", COMMENTED: "reviewed" };
	async function takeAsk(ask: Ask): Promise<void> {
		const { issue } = ask;
		const kind = issue.pull ? "pull request" : "issue";
		const ref = `${issue.slug}#${issue.number}`;
		const own = pulls.byNumber(issue.slug, issue.number);
		// One thread per issue or pull request: the one that opened Scout's own, the review thread of one Scout reviewed,
		// or the one an earlier request here started.
		const existing = own?.conversationId ?? inbox.threadOf(issue.slug, issue.number);
		const thread = existing === undefined ? undefined : threads.byConversation(existing);
		const where = (s: Ask["said"][number]) => (s.path === undefined ? "" : ` on ${s.path}${s.line === undefined ? "" : `:${s.line}`}`);
		const quoted = ask.said
			.map((s) => `*${s.author}*${s.review === undefined ? "" : ` ${REVIEW_WORDS[s.review] ?? "reviewed"}`}${where(s)} on <${s.url ?? issue.url}|${ref}>:\n${quote(s.body)}`)
			.join("\n\n");
		const said = ask.said.map((s) => `${s.author}${s.review === undefined ? "" : ` (${REVIEW_WORDS[s.review] ?? "reviewed"})`}${where(s)}: ${s.body.trim() || "(no comment)"}`).join("\n\n");

		// Not addressed to Scout: the thread gets it as context, the way a reply in Slack that isn't for Scout does.
		if (!ask.request) {
			if (existing === undefined || thread === undefined) return;
			await inThread(existing, quoted);
			await bridge.note(existing, `On ${forge.name}, on ${kind} ${ref}:\n\n${said}`, `forge-note:${ref}:${ask.said.map((s) => s.id ?? "").join(",")}`);
			return;
		}

		// A reflection's proposal is about the profile, which isn't a repository Scout works in, but people review it all the same.
		const profile = own?.kind === "profile" && config.profileRepo !== undefined ? { name: "profile", slug: config.profileRepo.slug } : undefined;
		const repo = profile ?? config.repos.find((r) => r.slug.toLowerCase() === issue.slug.toLowerCase());
		const say = (body: string) => forge.comment(issue.slug, issue.number, body);
		if (repo === undefined) {
			await say(`I'm not set up to work in ${issue.slug}, so I can't take this on. Whoever runs me can add it.`);
			return;
		}
		// Everyone who asked in what came in must be someone who may, not only the last of them (an assignment asks for
		// whoever assigned it). Whoever may not is context, as their reply in Slack would be.
		const refused = new Map<string, string>();
		for (const who of new Set(ask.said.filter((s) => s.addressed).map(askerOf))) {
			const allowed = who === "" ? { ok: false as const, reason: "I couldn't tell who assigned this to me, so I can't check they may ask me for work here. Mention me with what you'd like instead." } : await scout.mayAsk(who, repo);
			if (!allowed.ok) refused.set(who, allowed.reason);
		}
		for (const [who, reason] of refused) await say(who === "" ? reason : `@${who} ${reason}`);
		const asking = ask.said.filter((s) => s.addressed && !refused.has(askerOf(s)));
		if (asking.length === 0) return;
		const by = askerOf(asking.at(-1)!);
		const told = ask.said
			.map((s) => `${s.author}${s.review === undefined ? "" : ` (${REVIEW_WORDS[s.review] ?? "reviewed"})`}${where(s)}${s.addressed && refused.has(askerOf(s)) ? " (context only: they may not ask you for work here)" : ""}: ${s.body.trim() || "(no comment)"}`)
			.join("\n\n");
		// 👀 on what asked, so people on the code host see it was picked up; the answer follows when it's done.
		for (const s of asking) {
			await forge.acknowledge(issue.slug, issue.number, s.id).catch((error: unknown) => console.error(`couldn't react on ${ref}:`, error));
		}
		const verb = ask.why === "assigned" ? `assigned you ${kind}` : ask.why === "mentioned" ? `asked you in ${kind}` : `commented on your ${kind}`;
		const prompt = [
			`${by} ${verb} ${ref} "${issue.title}" on ${forge.name} (${issue.url}):`,
			told,
			ask.why === "own pull request"
				? "If they're asking for a change, make it and call open_pull_request again: it updates the same pull request. Otherwise answer them."
				: `Work on it as you would a request in Slack. Your answer goes in this thread and back on the ${kind} as a comment.${issue.pull ? "" : ` If you open a pull request that resolves the issue, put "Closes #${issue.number}" in its description.`}`,
		].join("\n\n");
		audit.record("request", { actor: by, detail: { as: forge.name.toLowerCase(), url: issue.url, why: ask.why, text: told.slice(0, 200) } });
		const requestId = `forge:${ref}:${ask.said.map((s) => s.id ?? s.url ?? s.body.length).join(",")}`;
		// What the thread may read of other repositories, each of them may (scout.ts, code search).
		const askedIn = (key: string) => {
			for (const s of asking) inbox.asked(key, askerOf(s));
		};

		if (existing !== undefined && thread !== undefined) {
			await inThread(existing, quoted);
			askedIn(thread.key);
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
		const root = `📥 *${by}* ${ask.why === "assigned" ? "assigned me" : "asked me on"} <${issue.url}|${ref}>: ${issue.title}\n${quote(ask.said.at(-1)?.body ?? "")}`;
		const threadTs = await slack.surface.post(channel, undefined, { text: root, blocks: [{ type: "markdown", text: root }] });
		const base = issue.pull ? await forge.headBranch(issue.slug, issue.number) : undefined;
		const context = [
			`This thread is for ${kind} ${ref} on ${forge.name}: ${issue.url}`,
			`# ${issue.title}\n\n${issue.body}`,
			...(base === undefined ? [] : [`Changes you make here go into the pull request's own branch, ${base}.`]),
		].join("\n\n");
		askedIn(threadKey(channel, threadTs));
		await bridge.investigate({ channel, channelName: name, threadTs, context, prompt, requestId, ...(base === undefined ? {} : { base }) });
		const conversationId = threads.get(threadKey(channel, threadTs))?.conversationId;
		if (conversationId !== undefined) {
			inbox.threadStarted(issue.slug, issue.number, conversationId);
			inbox.replyTo(conversationId, issue.slug, issue.number);
		}
		const link = await slack.permalink(channel, threadTs);
		await say(`On it, in the open: ${link === undefined ? `#${name} in Slack` : `[#${name}](${link})`}. I'll answer here too.`);
	}
	function quote(text: string): string {
		const clipped = text.trim().length > 600 ? `${text.trim().slice(0, 599)}…` : text.trim();
		return clipped === "" ? "" : clipped.split("\n").map((line) => `> ${line}`).join("\n");
	}
	// Scout's own open pull requests, between people's visits (upkeep.ts): kept mergeable, and not left to rot.
	const DAY = 24 * HOUR;
	const upkeep = new PullUpkeep({
		path: join(config.dataDir, "scout.sqlite"),
		forge,
		pingAfterMs: config.pullUpkeep.staleDays * DAY,
		closeAfterMs: config.pullUpkeep.closeDays * DAY,
		handlers: {
			threadActivity: (pull) => threads.byConversation(pull.conversationId)?.lastActivity,
			conflict: async (pull, status, attempt) => {
				if (threads.byConversation(pull.conversationId) === undefined) return;
				const base = await workspaces.refreshBase(pull.conversationId);
				const prompt = [
					`Your pull request ${pull.url} (${pull.slug} #${pull.number}) no longer merges cleanly into ${status.baseRef}: it has moved on since you branched. Its latest commits are now in your clone as origin/${base}.`,
					"If your branch has only your own commits, rebase it onto that; if anyone else has pushed to it, merge it in instead, so their commits stay as they made them. Resolve the conflicts keeping what both sides meant, run the tests, and call open_pull_request again: it updates the same pull request. If a conflict needs a person's call, say which and why, and leave it.",
					`This is automatic attempt ${attempt} of ${UPKEEP_TRIES}.`,
				].join("\n\n");
				await bridge.work(pull.conversationId, prompt, `conflict:${pull.url}:${status.head}:${status.base}`, "bring it up to date");
			},
			conflictStuck: async (pull, status) => {
				const asker = threads.byConversation(pull.conversationId)?.lastAsker;
				const who = !asker || asker === "scout" ? "Could someone" : `<@${asker}>, could you`;
				await inThread(pull.conversationId, `<${pull.url}|${pull.title}> still doesn't merge cleanly into ${status.baseRef} after ${UPKEEP_TRIES} tries at bringing it up to date. ${who} take a look?`);
			},
			nudge: async (pull, quietMs, closeAfterMs) => {
				const asker = threads.byConversation(pull.conversationId)?.lastAsker;
				const quiet = Math.round(quietMs / DAY);
				const close = Math.round(closeAfterMs / DAY);
				const who = !asker || asker === "scout" ? "" : `<@${asker}> `;
				await inThread(pull.conversationId, `${who}<${pull.url}|${pull.title}> has had no activity for ${quiet} days. Is it still wanted? If nothing changes, I'll close it in ${close} days; it can be reopened for ${config.closedBranchDays} days after that.`);
				await forge.comment(pull.slug, pull.number, `This has had no activity for ${quiet} days. Is it still wanted? If nothing changes, I'll close it in ${close} days; it can be reopened for ${config.closedBranchDays} days after that.`);
			},
			close: async (pull, quietMs) => {
				const quiet = Math.round(quietMs / DAY);
				await forge.comment(pull.slug, pull.number, `Closing this: no activity for ${quiet} days, including since I asked whether it's still wanted. If it is, reopen it within ${config.closedBranchDays} days (I keep its branch until then), or ask me in its thread.`);
				await forge.closePull(pull.slug, pull.number);
				await inThread(pull.conversationId, `I closed <${pull.url}|${pull.title}> after ${quiet} quiet days. If it's still wanted, reopen it within ${config.closedBranchDays} days, or ask me here.`);
				audit.record("pull_decided", { actor: "scout", conversationId: pull.conversationId, detail: { url: pull.url, state: "closed", why: "stale" } });
			},
		},
	});

	// Each channel's week, Mondays after the reflection hour (weekly.ts).
	const weekly = new WeeklySummaries(join(config.dataDir, "scout.sqlite"));
	async function postChannelWeeks(): Promise<void> {
		await refreshCanvases(true).catch((error: unknown) => console.error("refreshing canvases failed:", error));
		const to = weekStart(new Date(clock()));
		const from = to - 7 * DAY;
		const key = weekOf(new Date(from));
		const summaries = await channelWeeks(
			{
				threads: threads.startedBetween(from, to),
				pulls: pulls.touched(from, to),
				stillOpen: pulls.open("work"),
				canvased: canvases.channels(),
				notes: memory.active().filter((n) => n.createdAt >= from && n.createdAt < to),
				waiting: await Promise.all(
					recaps.waiting((c) => threads.byConversation(c)).map(async (t) => {
						const thread = threads.byConversation(t.conversationId);
						const link = thread === undefined ? undefined : await slack.permalink(thread.channel, thread.threadTs);
						return { ...t, ...(link === undefined ? {} : { link }) };
					}),
				),
				channelOf,
				spend: (channel) => {
					const budget = scout.limits.budgetFor(channel);
					return { cost: scout.spend.spent(from, channel) - scout.spend.spent(to, channel), ...(budget === undefined ? {} : { budget }) };
				},
			},
			clock(),
		);
		for (const [name, text] of summaries) {
			const id = await slack.channelId(name);
			if (id === undefined || !weekly.claim(key, name)) continue;
			await slack.surface.post(id, undefined, { text, blocks: [{ type: "markdown", text }] });
		}
	}

	// Threads that stalled waiting on people get one follow-up in the thread (recaps.ts).
	const recaps = new Recaps(join(config.dataDir, "scout.sqlite"));
	async function followUpStalledThreads(): Promise<void> {
		const hasOpenPull = (id: number) => pulls.forConversation(id).some((p) => p.state === "open");
		for (const id of recaps.due((c) => threads.byConversation(c), hasOpenPull, config.threadRecapDays * DAY, clock())) {
			recaps.recapped(id);
			const prompt = [
				`Nobody has replied here for ${config.threadRecapDays} days, and your last answer was waiting on someone.`,
				"For whoever picks this up, recap in a few lines: where things stand, what's left, and what you're waiting on and from whom (mention them by name). End with the one question that would move it on. Don't redo or continue any work.",
			].join(" ");
			await bridge.work(id, prompt, `recap:${id}:${localDay(new Date(clock()))}`, "follow up here");
		}
	}

	// Runs at once, for the run limits: every busy thread, plus the approaches threads are trying beyond their own run.
	async function runsNow(): Promise<{ channel: string }[]> {
		const runs = await Promise.all(bridge.working().map(async (w) => ({ channel: await channelOf(w.conversationId) })));
		for (const { parentId, count } of scout.approaches.working()) {
			const channel = await channelOf(parentId);
			for (let i = 1; i < count; i++) runs.push({ channel });
		}
		return runs;
	}
	// How many approaches a thread may run at once: what's free, plus the slot its own run already holds.
	scout.setApproachRoom(async (parentId) => scout.limits.free(await channelOf(parentId), await runsNow()) + 1);

	// Capacity now, for the dashboard and the metrics.
	const loopLag = eventLoopLag();
	function capacityNow() {
		return {
			active: bridge.working().length,
			maxRuns: config.capacity.maxRuns,
			queued: threads.queued().length,
			modelInFlight: scout.modelLimiter.inFlight,
			modelWaiting: scout.modelLimiter.waiting,
			modelMax: config.capacity.maxModelCalls,
			sandboxWaiting: scout.board.count("sandbox"),
			sandboxes: workspaces.open,
			progressWaiting: bridge.pacer.waiting,
			loopLag: loopLag(),
			waits: WAIT_KINDS.map((kind) => ({ kind, ...scout.capacity.waits(kind, 24 * HOUR) })),
			firstToken: scout.capacity.firstTokens(24 * HOUR),
		};
	}
	function capacityGauges(): Record<string, { help: string; value: number }> {
		const c = capacityNow();
		const gauges: Record<string, { help: string; value: number }> = {
			scout_runs_queued: { help: "Requests waiting their turn.", value: c.queued },
			scout_model_calls_in_flight: { help: "Model calls running now.", value: c.modelInFlight },
			scout_model_calls_waiting: { help: "Model calls waiting for a slot.", value: c.modelWaiting },
			scout_sandboxes_open: { help: "Sandboxes Scout has open.", value: c.sandboxes },
			scout_sandboxes_waiting: { help: "New sandboxes waiting for room on the sandbox host.", value: c.sandboxWaiting },
			scout_progress_edits_waiting: { help: "Progress edits waiting their turn under Slack's rate limit.", value: c.progressWaiting },
			scout_event_loop_lag_ms: { help: "Event-loop lag, mean over the last minute.", value: Math.round(c.loopLag.mean * 10) / 10 },
			scout_event_loop_lag_p99_ms: { help: "Event-loop lag, 99th percentile over the last minute.", value: Math.round(c.loopLag.p99 * 10) / 10 },
		};
		for (const w of c.waits) {
			gauges[`scout_wait_${w.kind}_p50_seconds`] = { help: `Median wait for ${w.kind} over the last day.`, value: Math.round(w.p50 / 1000) };
			gauges[`scout_wait_${w.kind}_p90_seconds`] = { help: `90th percentile wait for ${w.kind} over the last day.`, value: Math.round(w.p90 / 1000) };
		}
		gauges.scout_model_first_token_p50_seconds = { help: "Median time for a model call to start answering, over the last day.", value: Math.round(c.firstToken.p50 / 100) / 10 };
		gauges.scout_model_first_token_p90_seconds = { help: "90th percentile time for a model call to start answering, over the last day.", value: Math.round(c.firstToken.p90 / 100) / 10 };
		const outages = scout.breakers?.outages() ?? [];
		gauges.scout_models_failing = { help: "Models whose calls go to a fallback (or nowhere else) because they keep failing.", value: outages.length };
		gauges.scout_model_on_fallback = {
			help: "1 when SCOUT_MODEL keeps failing and its calls go to a fallback model.",
			value: outages.some((o) => o.model === `${config.model.provider}/${config.model.modelId}` && o.fallback !== undefined) ? 1 : 0,
		};
		return gauges;
	}

	// What Scout is doing, for "what are you working on?" (scout_status) and each person's App Home tab (home.ts).
	async function linkOf(conversationId: number): Promise<string | undefined> {
		const thread = threads.byConversation(conversationId);
		return thread === undefined ? undefined : slack.permalink(thread.channel, thread.threadTs).catch(() => undefined);
	}
	async function workingNow() {
		const now = Date.now();
		return Promise.all(
			bridge.working().map(async (w) => ({
				conversationId: w.conversationId,
				channel: await channelOf(w.conversationId),
				minutes: Math.round((now - w.startedAt) / MINUTE),
				...(w.lastStep === undefined ? {} : { lastStep: w.lastStep }),
			})),
		);
	}
	scout.setStatus((channel) => describeNow(channel));
	async function describeNow(channel: string): Promise<string> {
		const working = await workingNow();
		const waiting = recaps.waiting((c) => threads.byConversation(c)).length;
		const here = scout.schedules.forChannel(channel);
		const lines = [
			working.length === 0 ? "Not working on anything else right now." : `Working on ${working.length} thing${working.length === 1 ? "" : "s"}:`,
			...working.map((w) => `- #${w.channel}, ${w.minutes} min${w.lastStep === undefined ? "" : `, on ${w.lastStep}`}`),
			`${threads.queued().length} request(s) waiting to start.`,
			`${waiting} thread(s) waiting on people after a follow-up.`,
			here.length === 0 ? "No schedules in this channel." : `Schedules here: ${here.map((s) => `#${s.id} ${s.when}: ${s.task}${s.paused ? " (paused)" : ""}`).join("; ")}`,
		];
		return lines.join("\n");
	}
	async function homeFor(user: string) {
		return homeView(await homeData(user));
	}
	async function homeData(user: string): Promise<HomeData> {
		const threadOf = (c: number) => threads.byConversation(c);
		const queuedKeys = new Set(threads.queued().map((q) => q.key));
		const mine = threads.forPerson(user, 10);
		const theirs = await Promise.all(
			mine.map(async (t) => {
				const busy = bridge.view(t.conversationId)?.busy === true;
				const asking = t.lastAsker === user && (scout.approvals.waiting(t.conversationId) || recaps.asking(t.conversationId, threadOf));
				const state: HomeThread["state"] = busy ? "working" : queuedKeys.has(t.key) ? "queued" : asking ? "waiting on you" : "answered";
				const link = await linkOf(t.conversationId);
				return {
					...(link === undefined ? {} : { link }),
					channel: await channelOf(t.conversationId),
					about: scout.search.first(t.conversationId)?.text ?? "",
					state,
					approval: scout.approvals.waiting(t.conversationId),
				};
			}),
		);
		const working = await Promise.all((await workingNow()).map(async (w) => {
			const link = await linkOf(w.conversationId);
			return { ...w, ...(link === undefined ? {} : { link }) };
		}));
		return {
			working,
			queued: threads.queued().length,
			threads: theirs.map(({ approval: _, ...t }) => t),
			waitingOnYou: theirs
				.filter((t) => t.state === "waiting on you")
				.map((t) => ({ ...(t.link === undefined ? {} : { link: t.link }), channel: t.channel, what: t.approval ? "a change waiting for your approval (reply “approve” or 👍 my answer)" : "a question I asked you" })),
			schedules: scout.schedules.all().filter((s) => s.createdBy === user),
		};
	}

	// The list of Scout's work (worklist.ts): one row per thread, kept up to date as the work moves. Shared with the home
	// channel. Only where the workspace allows Lists; otherwise nothing changes.
	const workList = new WorkList({
		path: join(config.dataDir, "scout.sqlite"),
		api: () => slack.lists as never,
		shareWith: async () => (config.reflect.channel === undefined ? undefined : slack.channelId(config.reflect.channel)),
	});
	async function track(conversationId: number, row: WorkRow): Promise<void> {
		if (!allows(config.initiative, "team")) return;
		const thread = threads.byConversation(conversationId);
		if (thread === undefined) return;
		const first = workList.id === undefined || !trackedOnce.has(conversationId);
		trackedOnce.add(conversationId);
		const full: WorkRow = first
			? {
					request: scout.search.first(conversationId)?.text ?? "",
					channel: thread.channel,
					...(thread.startedBy.startsWith("U") ? { askedBy: thread.startedBy } : {}),
					...(await linkOf(conversationId).then((link) => (link === undefined ? {} : { thread: link }))),
					...row,
				}
			: row;
		await capabilities.use("lists", () => workList.update(conversationId, full)).catch((error: unknown) => console.error("updating the list of Scout's work failed:", error));
	}
	const trackedOnce = new Set<number>();

	// Each repository channel's Scout canvas (weekly.ts): what's open, who's waiting, schedules and notes, kept current.
	const canvases = new ChannelCanvases(join(config.dataDir, "scout.sqlite"));
	async function refreshCanvases(force = false): Promise<void> {
		if (!capabilities.on("canvases")) return;
		const now = clock();
		const channels = new Set(config.repos.flatMap((r) => scout.channelOf(r.name)?.name ?? []));
		const waitingAll = recaps.waiting((c) => threads.byConversation(c));
		for (const name of channels) {
			const known = canvases.get(name);
			if (!force && known !== undefined && now - known.updatedAt < 6 * HOUR) continue;
			const id = await slack.channelId(name);
			if (id === undefined) continue;
			const inHere = async (conversationId: number) => (await channelOf(conversationId)) === name;
			const open = (await Promise.all(pulls.open("work").map(async (p) => ((await inHere(p.conversationId)) ? [p] : [])))).flat();
			const waiting = (
				await Promise.all(
					waitingAll.map(async (t) => {
						if (!(await inHere(t.conversationId))) return [];
						const link = await linkOf(t.conversationId);
						return [{ since: t.since, ...(link === undefined ? {} : { link }) }];
					}),
				)
			).flat();
			const markdown = channelCanvas({
				channel: name,
				open,
				waiting,
				schedules: scout.schedules.forChannel(name),
				notes: memory.forChannel(name),
				...(workList.id === undefined || slack.teamUrl === "" ? {} : { listUrl: `${slack.teamUrl}lists/${slack.teamId}/${workList.id}` }),
				now,
			});
			const canvasId = await capabilities.use("canvases", () => slack.channelCanvas(id, known?.canvasId, markdown));
			if (canvasId !== undefined && canvasId !== "") canvases.saved(name, canvasId, now);
		}
	}

	// Closed pull requests' branches, once they've been closed long enough (and weren't reopened).
	const branches = new BranchCleanup(join(config.dataDir, "scout.sqlite"));
	async function cleanUpBranches(): Promise<void> {
		for (const pull of branches.due(clock())) {
			await deleteBranchOf(pull);
			branches.done(pull.url);
		}
	}

	/** A decided pull request's branch, if it's one of Scout's and nothing else still comes from it. */
	async function deleteBranchOf(pull: { slug: string; number: number; conversationId: number; url: string }): Promise<void> {
		const status = await forge.pullStatus(pull.slug, pull.number);
		if (!status.headRef.startsWith("scout/") || status.open) return;
		if (pulls.forConversation(pull.conversationId).some((p) => p.state === "open" && p.url !== pull.url)) return;
		await forge.deleteBranch(pull.slug, status.headRef);
	}

	/** Ask the files' owners (CODEOWNERS, or who changed them lately) and whoever asked to review a new pull request; returns who. */
	async function askForReviews(pull: { slug: string; number: number }, asker: string | undefined): Promise<string[]> {
		if (!allows(config.initiative, "own")) return [];
		const repo = config.repos.find((r) => r.slug.toLowerCase() === pull.slug.toLowerCase());
		if (repo === undefined) return [];
		const me = await forge.me();
		const askerLogin = asker === undefined || asker === "scout" ? undefined : await scout.loginOf(asker);
		const files = await forge.pullFiles(pull.slug, pull.number);
		const owners = await scout.reviewersFor(repo.name, files, [me]);
		const users = [...new Set([...(askerLogin === undefined ? [] : [askerLogin]), ...owners.users])].filter((u) => u.toLowerCase() !== me.toLowerCase()).slice(0, 3);
		await forge.requestReviewers(pull.slug, pull.number, { users, teams: owners.teams });
		return [...users, ...owners.teams].map((who) => `@${who}`);
	}

	// Pull requests waiting on review in each channel's repositories, anyone's: one gentle reminder a working day.
	const reviewNudges = new ReviewNudges({ path: join(config.dataDir, "scout.sqlite"), forge, waitMs: config.reviewNudgeDays * DAY });
	async function nudgeReviews(): Promise<void> {
		const repos = config.repos.flatMap((r) => {
			const channel = scout.channelOf(r.name)?.name;
			return channel === undefined ? [] : [{ slug: r.slug, channel }];
		});
		const now = clock();
		for (const [channel, waiting] of await reviewNudges.waiting(repos, localDay(new Date(now)), now)) {
			const id = await slack.channelId(channel);
			if (id === undefined) continue;
			const who = (login: string) => {
				const user = scout.slackUserOf(login);
				return user === undefined ? `@${login}` : `<@${user}>`;
			};
			const lines = waiting.map(
				(p) => `• <${p.url}|${p.slug}#${p.number}> ${p.title}${p.author === "" ? "" : ` by ${p.author}`}: waiting on ${[...p.reviewers.map(who), ...p.teams.map((t) => `@${t}`)].join(", ")} for ${Math.floor((now - p.createdAt) / DAY)} days`,
			);
			const text = [`A few pull requests have been waiting on review for a while:`, ...lines].join("\n");
			await slack.surface.post(id, undefined, { text, blocks: [{ type: "markdown", text }] });
		}
	}

	const inboxTick = () => health.watch("code host", "reading the code host's notifications failed", () => inbox.poll());
	every(MINUTE, () => void inboxTick());

	// The nightly benchmark (bench.ts), off unless SCOUT_BENCH_MODELS names models: a process of its own (bench-cli.ts),
	// once a night after SCOUT_BENCH_HOUR, so its runs never share Scout's harness or hold up Slack.
	const benchStore = config.bench === undefined ? undefined : new BenchStore(join(config.dataDir, "bench.sqlite"));
	let benchChild: ChildProcess | undefined;
	let benchTried: string | undefined;
	const benchNight = () => {
		if (config.bench === undefined || benchChild !== undefined || draining !== undefined) return;
		const now = new Date(clock());
		const night = localDay(now);
		// Once a night, whether it worked or not: a broken run shouldn't start again every few minutes.
		if (now.getHours() < config.bench.hour || benchTried === night || benchStore?.lastRun() === night) return;
		benchTried = night;
		console.log(`benchmark: starting tonight's runs (${config.bench.models.map((m) => `${m.provider}/${m.modelId}`).join(", ")})`);
		benchChild = spawn(process.execPath, [join(import.meta.dirname, "bench-cli.ts")], { stdio: "inherit" });
		benchChild.on("exit", (code) => {
			benchChild = undefined;
			if (code !== 0) console.error(`benchmark: tonight's runs stopped with exit code ${code}`);
			else console.log("benchmark: tonight's runs are done");
		});
	};

	/** Housekeeping every few minutes; also soon after a start, so a restart doesn't hold up reviews and retries. */
	const housekeeping = async (): Promise<void> => {
		// Draining for a restart: the next process does it, rather than this one starting what it can't finish.
		if (draining !== undefined) return;
		const work: Promise<unknown>[] = [];
		const now = clock();
		// Sandboxes are cattle: put to sleep the ones whose threads went quiet; the next tool call wakes them (a spoond lease
		// in under a second), so sleeping early costs little and leaves room for other threads.
		for (const thread of threads.activeSince(now - 24 * HOUR)) {
			if (thread.lastActivity < now - 15 * MINUTE && !bridge.view(thread.conversationId)?.busy) {
				work.push(workspaces.suspend(thread.conversationId));
			}
		}
		if (config.profileRepo !== undefined) {
			work.push(health.watch("profile", "pulling the profile failed", () => pullProfile(config.profileDir)));
		}
		const own = allows(config.initiative, "own");
		const team = allows(config.initiative, "team");
		if (own && new Date(now).getHours() >= config.reflect.hour) work.push(reflect(localDay(new Date(now))));
		benchNight();
		work.push(health.watch("reviews", "reviewing pull requests failed", () => pullReviewer.poll()));
		if (own) {
			work.push(health.watch("upkeep", "looking after Scout's pull requests failed", () => upkeep.poll(pulls.open("work"), now)));
			work.push(health.watch("branches", "deleting closed pull requests' branches failed", cleanUpBranches));
			work.push(health.watch("recaps", "following up on stalled threads failed", followUpStalledThreads));
		}
		if (team) work.push(health.watch("canvases", "refreshing the channels' canvases failed", () => refreshCanvases()));
		// Waiting that has become common or is growing: tell whoever runs Scout, with what would help (once a day at most).
		if (team) {
			const notice = scout.capacity.notice({ maxRuns: config.capacity.maxRuns, maxModelCalls: config.capacity.maxModelCalls });
			if (notice !== undefined) announce(notice);
		}
		const today = new Date(now);
		if (team && today.getDay() >= 1 && today.getDay() <= 5 && today.getHours() >= 9 && today.getHours() < 17) {
			work.push(health.watch("review nudges", "reminding reviewers failed", nudgeReviews));
		}
		work.push(
			health.watch("images", "building repository images failed", async () => {
				if (!allows(config.initiative, "own")) return;
				for (const line of await scout.refreshImages()) console.log(line);
			}),
		);
		const decidedPulls = health.watch("pulls", "checking pull requests failed", () => pulls.refresh(config.codeHost, doFetch, clock()));
		work.push(decidedPulls.then(async (decided = []) => {
			// A reflection's proposal was decided: merged retires the notes it covered; rejected keeps them.
			for (const pull of decided) {
				audit.record("pull_decided", { actor: "code host", conversationId: pull.conversationId, detail: { url: pull.url, state: pull.state } });
				// Merged: its branch has done its job. Closed: kept a while, so it can still be reopened.
				if (pull.kind === "work") void track(pull.conversationId, { state: pull.state === "merged" ? "Merged" : "Closed" });
				if (!allows(config.initiative, "own")) continue;
				if (pull.state === "merged") await deleteBranchOf(pull).catch((error: unknown) => console.error(`deleting ${pull.url}'s branch failed:`, error));
				else branches.later(pull, clock() + config.closedBranchDays * DAY);
				const day = pull.kind === "profile" ? threads.reflectionDay(pull.conversationId) : undefined;
				if (day !== undefined) memory.proposalDecided(day, pull.state === "merged");
			}
			// Mondays, after the reflection hour: how last week went.
			const today = new Date(clock());
			if (!allows(config.initiative, "team") || today.getDay() !== 1 || today.getHours() < config.reflect.hour) return;
			const report = pulls.weeklyReport(weekOf(today), clock(), scout.spend.spent(0));
			const more = [scout.capacity.weekLine(), backupWeekLine(backup)].filter((line) => line !== undefined);
			const text = report === undefined || more.length === 0 ? report : `${report} ${more.join(" ")}`;
			if (text !== undefined) announce(text);
			if (config.weeklySummary) await health.watch("weekly", "posting the channels' weekly summaries failed", postChannelWeeks);
		}));
		// What quiet threads leave behind, past the retention period.
		const retentionDays = config.governance.retentionDays;
		if (retentionDays !== undefined) {
			work.push(
				health.watch("retention", "deleting old thread files failed", () =>
					applyRetention({ days: retentionDays, threads, workspaces, search: scout.search, memory, audit }),
				),
			);
		}
		await Promise.all(work);
	};
	every(5 * MINUTE, () => void housekeeping());
	const firstTick = options.timers === false ? undefined : setTimeout(() => void housekeeping(), 30_000);

	// `kill -HUP <pid>` reads secrets again. The code host token, the gateway key and spoond's token apply at once; Slack
	// tokens and MCP servers' credentials need a restart.
	async function rotateSecrets(): Promise<void> {
		try {
			const changed = await (options.rotateSecrets ?? (async () => []))();
			config.codeHost.token = process.env.SCOUT_CODEHOST_TOKEN ?? config.codeHost.token;
			if (config.gateway !== undefined && process.env.SCOUT_GATEWAY_KEY !== undefined) config.gateway.key = process.env.SCOUT_GATEWAY_KEY;
			console.log(changed.length === 0 ? "secrets: nothing changed" : `secrets rotated: ${changed.join(", ")}`);
			if (changed.some((name) => name.startsWith("SLACK_"))) console.log("Slack tokens changed: restart Scout to use them");
		} catch (error) {
			console.error("rotating secrets failed:", error);
		}
	}

	// What Scout is doing, as the dashboard shows it; `/scout doctor` checks the running Scout by it too.
	const collector = new Collector({
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
		capacity: () => capacityNow(),
		models: () => ({
			primary: `${config.model.provider}/${config.model.modelId}`,
			fallbacks: scout.breakers?.fallbacks.slice() ?? [],
			outages: scout.breakers?.outages() ?? [],
		}),
		draining: () => draining,
		backup: () => backup,
	});

	// The dashboard: read-only, on its own address (loopback unless it has a password).
	const dashboard =
		config.dash === undefined
			? undefined
			: await startDashboard({
					addr: config.dash.addr,
					...(config.dash.auth === undefined ? {} : { auth: config.dash.auth }),
					collector,
					...(config.bench === undefined || benchStore === undefined
						? {}
						: {
								bench: () => ({
									scores: benchStore.scores(),
									...(benchStore.lastRun() === undefined ? {} : { lastRun: benchStore.lastRun()! }),
									keep: KEEP_RUNS,
									hour: config.bench!.hour,
									tasks: loadTasks(config.bench!.tasksDir).length,
								}),
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
								scout_backup_ok: backupGauge(backup),
								...capacityGauges(),
							});
						},
					},
				});
	if (config.dash !== undefined) console.log(`dashboard on http://${config.dash.addr}/`);

	// `kill -USR2 <pid>` reflects now, if today's reflection hasn't run yet.
	const reflectNow = () => reflect(localDay(new Date(clock())));

	/**
	 * A drain for a restart (drain.ts): no new model calls start, and the model calls and tool calls running now finish,
	 * for at most `SCOUT_DRAIN_MAX` seconds. Housekeeping and the benchmark stop starting things meanwhile.
	 */
	async function drain(): Promise<void> {
		draining = clock();
		// The nightly benchmark is a process of its own, with runs too long to wait for: tonight's are lost.
		benchChild?.kill();
		console.log(`draining for a restart: the model calls and tool calls running now finish first, for at most ${config.capacity.drainMax} s (SIGINT again stops now)`);
		try {
			const drained = await scout.drain(config.capacity.drainMax * 1000);
			const said = drained.idle ? "drained" : `still busy (${drained.modelCalls} model call(s), ${drained.toolCalls} tool call(s)), stopping anyway`;
			console.log(`${said} after ${Math.round(drained.ms / 1000)} s; the next start carries every run on`);
		} catch (error) {
			console.error("draining failed; stopping:", error);
		}
	}

	/** Timers stopped, stores closed, Slack and the dashboard stopped, Scout closed; the process carries on. */
	let closed: Promise<void> | undefined;
	function close(): Promise<void> {
		closed ??= (async () => {
			// What answers set off, before the stores it writes to close; at most half a minute, so a stuck call can't hold a stop.
			await Promise.race([Promise.allSettled([...afterAnswers]), new Promise((resolve) => setTimeout(resolve, 30_000).unref())]);
			for (const timer of timers) clearInterval(timer);
			clearTimeout(firstTick);
			benchChild?.kill();
			benchStore?.close();
			inbox.close();
			upkeep.close();
			weekly.close();
			reviewNudges.close();
			branches.close();
			recaps.close();
			workList.close();
			canvases.close();
			capabilities.close();
			egress.close();
			alertLog.close();
			await slack.stop().catch(() => {});
			await dashboard?.close();
			await scout.close();
		})();
		return closed;
	}

	// `kill -INT <pid>` drains for a restart: once drained, Scout stops cleanly, its service manager starts it again
	// (Restart=always), and every run carries on from the step it stopped at. SIGTERM stops at once, as does a second
	// SIGINT while draining. scripts/deploy.sh drains this way, and updates the code only once Scout has stopped.
	let stopping = false;
	async function stop(): Promise<void> {
		if (stopping) return exit(1);
		stopping = true;
		await close();
		exit(0);
	}
	function signal(name: Signal): void {
		switch (name) {
			case "SIGINT":
				if (draining !== undefined || stopping) return void stop();
				// Stopped meanwhile (a second signal), it's already on its way out.
				return void drain().then(() => (stopping ? undefined : stop()));
			case "SIGTERM":
				return void stop();
			case "SIGHUP":
				return void rotateSecrets();
			case "SIGUSR2":
				return void reflectNow();
		}
	}

	return {
		config,
		scout,
		slack,
		bridge,
		health,
		collector,
		/** The dashboard's port, when it has an address (SCOUT_DASH_ADDR; port 0 picks one). */
		dashboardPort: dashboard?.port,
		/** Messages said while Scout was away, read back and taken in. */
		caughtUp,
		/** Since when Scout has been draining, if it is. */
		draining: () => draining,
		/** What runs on timers, run now; each settles once its work has. */
		tick: {
			housekeeping,
			alerts: alertTick,
			ci: ciTick,
			inbox: inboxTick,
			schedules: scheduleTick,
			waits: waitsTick,
			watchdog,
			backup: backupTick,
			heartbeat,
		},
		reflect: reflectNow,
		rotateSecrets,
		drain,
		/** What `main.ts` does on a process signal; stopping ends in `exit`. */
		signal,
		close,
	};
}

/** Random per install; keeps container, directory and branch names unique. */
function instanceId(dataDir: string): string {
	const path = join(dataDir, "instance");
	if (existsSync(path)) return readFileSync(path, "utf8").trim();
	const id = randomBytes(3).toString("hex");
	writeFileSync(path, `${id}\n`);
	return id;
}

/** The systemd unit Scout runs in, if it runs under systemd (for the doctor's restart check). */
function ownUnit(): Unit | undefined {
	try {
		return unitOf(readFileSync("/proc/self/cgroup", "utf8"));
	} catch {
		return undefined;
	}
}
