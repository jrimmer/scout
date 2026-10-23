import type { Context } from "@earendil-works/chord";
import { type AgentChange, type ConversationId, type Harness, watchEvents } from "@earendil-works/pi-durable";
import type { Audit } from "./audit.ts";
import { delivery } from "./etiquette.ts";
import type { Admission } from "./limits.ts";
import { ThreadDoc } from "./docs.ts";
import type { ThreadSearch } from "./search.ts";
import { type ChatMessage, type ChatSurface, ProgressPacer, type RunOutcome, ThreadView } from "./render.ts";
import { DEFAULT_EMOJI, type Ending, type Phase, StatusReactions } from "./reactions.ts";
import { asksSomething } from "./recaps.ts";
import { threadKey, type ThreadRow, type Threads } from "./threads.ts";

/** A Slack message as the bridge needs it; the Slack adapter decodes events into this. */
export type IncomingMessage = {
	channel: string;
	/** `channel` is public; `group` private; `im` and `mpim` direct messages. */
	channelType: "channel" | "group" | "im" | "mpim";
	channelName: string;
	user: string;
	text: string;
	ts: string;
	threadTs?: string;
	/** Files shared with the message. */
	files?: SharedFile[];
};

export type SharedFile = { name: string; mimetype: string; size: number; url: string };

/** Images the model looks at directly; at most this big. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IMAGE_LIMIT = 5 * 1024 * 1024;
/** Other files go into the thread's workspace; at most this big. */
const FILE_LIMIT = 20 * 1024 * 1024;

export type BridgeOptions = {
	harness: Harness;
	threads: Threads;
	surface: ChatSurface;
	botUserId: string;
	/** Display name for a Slack user ID. */
	nameOf: (user: string) => Promise<string>;
	/** Agent for new threads: model, thinking level. */
	agent: AgentChange;
	context: Context;
	/** Offered on a direct message: a public channel for the two of you. */
	channelOffer?: (user: string) => ChatMessage;
	/** Where what's said in threads is indexed, for `search_threads`. */
	search?: ThreadSearch;
	/** The repository a channel's threads work in. */
	/** A person replied "approve" in a thread: let changes that need approval go ahead there (mcp.ts). */
	approve?: (conversationId: number, user: string) => void;
	/**
	 * A run ended with `answer` (none when it was stopped) in message `ts`. If a change waited for approval, a 👍 there
	 * approves (mcp.ts); if someone asked on the code host, the answer goes back there too (forge.ts).
	 */
	answered?: (conversationId: number, ts: string | undefined, answer: string | undefined, outcome: RunOutcome) => void;
	/** A run started in this conversation (its progress message is up). */
	runStarted?: (conversationId: number) => void;
	/** The conversation whose answer in message `ts` asked for approval, if one did. */
	approvalAskedIn?: (ts: string) => number | undefined;
	/** Whether to mark requests with reactions (👀 picked up, ✅ answered, ⚠️ a problem): the reactions:write scope. */
	reactionsOn?: () => boolean;
	/** Whether the reaction follows what Scout is doing (🧠, 📖, 🧪…) or only picked up and done (SCOUT_STATUS_REACTIONS). */
	reactionPhases?: () => boolean;
	/** What to expect when `place`th in line ("about 2–6 minutes"), from how long runs take; undefined without data. */
	queueEta?: (place: number) => string | undefined;
	/** Something waited its turn (a request in the queue), for the capacity record. */
	waited?: (kind: "run", ms: number) => void;
	/** A run finished after `ms`, for the capacity record. */
	ran?: (ms: number) => void;
	/** What a run is waiting on right now, in Scout's words (a sandbox, the model), or nothing. */
	waitingFor?: (conversationId: number) => Promise<string | undefined>;
	/** Whether a conversation's model calls went to a fallback model (its own is failing), in Scout's words. */
	fallbackNotice?: (conversationId: number) => Promise<string | undefined>;
	/** The emoji for a phase (the profile's reactions.md, or the defaults). */
	reactionEmoji?: (phase: Phase | Ending) => string;
	/** What a run in this conversation since `since` cost, for its reply's footer (limits.ts). */
	costNote?: (conversationId: number, since: number) => string;
	/** The repository a thread starts in, from its channel and its first message. */
	repoFor?: (channelName: string, text?: string) => string;
	/** A channel's own model, if its profile names one; otherwise `agent`'s. */
	modelFor?: (channelName: string) => { provider: string; modelId: string } | undefined;
	/** Download a shared file, up to `limit` bytes (Slack needs the bot's token for that). */
	download?: (url: string, limit: number) => Promise<Uint8Array>;
	/** Put a shared file where the thread's tools can read it; returns its path there. */
	saveAttachment?: (conversationId: number, name: string, bytes: Uint8Array) => Promise<string>;
	/**
	 * May this person's message start (`starting`) or steer work? Requester permissions, budgets and concurrency
	 * (permissions.ts, limits.ts). Refused, the message is kept as context and Scout says why; told to wait, the
	 * request is queued until a run ends.
	 */
	admit?: (request: { user: string; channelName: string; repo?: string; starting: boolean }) => Promise<Admission>;
	audit?: Audit;
};

/** Say the same refusal to the same person in the same thread at most this often. */
const REFUSAL_QUIET_MS = 60 * 60 * 1000;

/** Reactions that stop Scout's work in a thread, on the thread's first message or on Scout's progress message. */
export const STOP_REACTIONS = new Set(["octagonal_sign", "no_entry", "no_entry_sign"]);
/** Reactions that approve, on the answer where Scout asked for approval. */
/** 🔁 on Scout's latest answer asks it to try again. */
export const RETRY_REACTIONS = new Set(["repeat", "arrows_counterclockwise"]);
/** How long after a model call had to retry Scout warns that it may be slow. */
const BEHIND_MS = 10 * 60 * 1000;

function ordinal(n: number): string {
	const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
	return `${n}${suffix}`;
}

export const APPROVE_REACTIONS = new Set(["+1", "thumbsup", "white_check_mark", "heavy_check_mark"]);

const STOP_WORDS = /^\s*(stop|cancel|halt)\b/i;

export const DECLINE_PRIVATE =
	"I only work in public channels, so everyone can see what we do and learn from it. " +
	"Mention me in a public channel and I'll pick it up there.";

/**
 * Turns Slack messages into conversation submissions and runs into Slack replies.
 *
 * One Slack thread is one conversation. A thread starts when someone mentions Scout in a public channel; after that,
 * everything said in the thread goes to its conversation (see etiquette.ts for what Scout answers).
 */
export class Bridge {
	readonly #options: BridgeOptions;
	readonly #views = new Map<number, ThreadView>();
	/** The messages each conversation's current run took as requests, whose reaction follows the run. */
	readonly #requests = new Map<number, { channel: string; ts: string }[]>();
	/** One reaction per request, smoothed and paced for the whole workspace (reactions.ts). */
	readonly #status: StatusReactions;
	/** Progress edits for every thread, paced under Slack's limit (render.ts). */
	readonly pacer = new ProgressPacer();
	/** When a model call last had to wait and retry, in any thread: lately, new runs warn they may be slow. */
	#slowAt = 0;
	readonly #locks = new Map<string, Promise<unknown>>();
	readonly #refused = new Map<string, number>();
	#draining = false;

	constructor(options: BridgeOptions) {
		this.#options = options;
		this.#status = new StatusReactions({
			react: (channel, ts, name, on) => this.#react(channel, ts, name, on),
			emoji: (phase) => options.reactionEmoji?.(phase) ?? DEFAULT_EMOJI[phase],
		});
	}

	/** A request's reaction: a phase only when phases are on; picked up and endings always. */
	#phase(channel: string, ts: string, phase: Phase): void {
		if (phase !== "picked" && phase !== "queued" && this.#options.reactionPhases?.() === false) return;
		this.#status.set(channel, ts, phase);
	}

	/** Reattach to recent threads after a restart, so runs the harness resumes still reach Slack. */
	async reattach(since: number): Promise<void> {
		for (const thread of this.#options.threads.activeSince(since)) await this.#view(thread);
	}

	view(conversationId: number): ThreadView | undefined {
		return this.#views.get(conversationId);
	}

	/** Threads Scout is working in right now. */
	working(): { conversationId: number; startedAt: number; steps: number; lastStep?: string }[] {
		return [...this.#views].flatMap(([conversationId, view]) => {
			const info = view.runInfo;
			return info === undefined ? [] : [{ conversationId, ...info }];
		});
	}

	async onMessage(message: IncomingMessage): Promise<void> {
		const { botUserId, surface } = this.#options;
		if (message.user === botUserId) return;
		const mentions = message.text.includes(`<@${botUserId}>`);

		if (message.channelType === "im") {
			const offer = this.#options.channelOffer?.(message.user);
			await surface.post(message.channel, undefined, offer ?? plain(DECLINE_PRIVATE));
			return;
		}
		if (message.channelType !== "channel") {
			if (mentions) await surface.post(message.channel, message.threadTs ?? message.ts, plain(DECLINE_PRIVATE));
			return;
		}

		const key = threadKey(message.channel, message.threadTs ?? message.ts);
		const thread = this.#options.threads.get(key);
		if (mentions && thread !== undefined && STOP_WORDS.test(this.#withoutMention(message.text))) {
			await this.#stop(thread, message.user);
			return;
		}
		await this.#serialized(key, () => this.#deliver(key, message, mentions, false));
	}

	/** Start queued requests that may start now, oldest first; stop at the first that still has to wait. */
	async drain(): Promise<void> {
		if (this.#draining) return;
		this.#draining = true;
		try {
			for (const item of this.#options.threads.queued()) {
				const message = item.message as IncomingMessage;
				const mentions = message.text.includes(`<@${this.#options.botUserId}>`);
				const outcome = await this.#serialized(item.key, () => this.#deliver(item.key, message, mentions, true));
				if (outcome === "waiting") return;
				this.#options.threads.dequeue(item.id);
				this.#options.waited?.("run", Date.now() - item.at);
			}
		} finally {
			this.#draining = false;
		}
	}

	/**
	 * A reaction on a message: a stop sign on a thread's first message or on Scout's progress message stops it; a 👍 on
	 * the answer where Scout asked for approval is that person replying "approve".
	 */
	async onReaction(reaction: { channel: string; ts: string; name: string; user: string; eventTs: string }): Promise<void> {
		if (APPROVE_REACTIONS.has(reaction.name)) {
			const conversationId = this.#options.approvalAskedIn?.(reaction.ts);
			const thread = conversationId === undefined ? undefined : this.#options.threads.byConversation(conversationId);
			if (thread === undefined || thread.channel !== reaction.channel) return;
			const { harness, context } = this.#options;
			const channelName = (await harness.snapshot(ThreadDoc, thread.conversationId as ConversationId, context))?.channelName ?? "";
			await this.onMessage({ channel: reaction.channel, channelType: "channel", channelName, user: reaction.user, text: "approve", ts: reaction.eventTs, threadTs: thread.threadTs });
			return;
		}
		if (RETRY_REACTIONS.has(reaction.name)) {
			// 🔁 on Scout's latest answer: try that again, as if they'd asked in the thread (so it's admitted and audited).
			const thread = this.#options.threads.byAnswer(reaction.channel, reaction.ts);
			if (thread === undefined) return;
			const { harness, context } = this.#options;
			const channelName = (await harness.snapshot(ThreadDoc, thread.conversationId as ConversationId, context))?.channelName ?? "";
			const text = `<@${this.#options.botUserId}> 🔁 please try that again, picking up where it stopped.`;
			await this.onMessage({ channel: reaction.channel, channelType: "channel", channelName, user: reaction.user, text, ts: reaction.eventTs, threadTs: thread.threadTs });
			return;
		}
		if (!STOP_REACTIONS.has(reaction.name)) return;
		let thread = this.#options.threads.get(threadKey(reaction.channel, reaction.ts));
		if (thread === undefined) {
			for (const [conversationId, view] of this.#views) {
				if (view.runTs === reaction.ts) thread = this.#options.threads.byConversation(conversationId);
			}
		}
		if (thread !== undefined && thread.channel === reaction.channel) await this.#stop(thread, reaction.user);
	}

	/**
	 * Someone edited a message. A request still waiting its turn is replaced; one Scout is working on steers the run
	 * ("ann edited her request: …"). An edit after Scout has answered is left alone: they can ask again.
	 */
	async onEdit(edit: { channel: string; ts: string; threadTs?: string; user: string; text: string }): Promise<void> {
		const { threads, harness, context } = this.#options;
		const waiting = threads.queued().find((q) => (q.message as IncomingMessage).ts === edit.ts && (q.message as IncomingMessage).channel === edit.channel);
		if (waiting !== undefined) {
			threads.requeue(waiting.id, { ...(waiting.message as IncomingMessage), text: edit.text });
			return;
		}
		const thread = threads.get(threadKey(edit.channel, edit.threadTs ?? edit.ts));
		if (thread === undefined || thread.lastAsker !== edit.user) return;
		const view = this.#views.get(thread.conversationId);
		if (view?.busy !== true) return;
		const name = await this.#options.nameOf(edit.user);
		const text = edit.text.replaceAll(`<@${this.#options.botUserId}>`, "@Scout").trim();
		const conversation = await harness.conversation(thread.conversationId as ConversationId, context);
		await conversation?.submit({ type: "input", content: `${name} edited their request: ${text}`, whenBusy: "steer", requestId: `slack-edit:${edit.channel}:${edit.ts}:${text.length}` }, context);
		view.tookIn(name);
	}

	async #react(channel: string, ts: string, name: string, on: boolean): Promise<void> {
		const { surface } = this.#options;
		if (surface.react === undefined || this.#options.reactionsOn?.() !== true) return;
		// A request made by a reaction or a button has no message of its own to mark; that's fine.
		await surface.react(channel, ts, name, on).catch(() => {});
	}

	/** Someone deleted a message: a request still waiting its turn is dropped. */
	onDelete(deleted: { channel: string; ts: string }): void {
		const { threads } = this.#options;
		const waiting = threads.queued().find((q) => (q.message as IncomingMessage).ts === deleted.ts && (q.message as IncomingMessage).channel === deleted.channel);
		if (waiting !== undefined) threads.requeue(waiting.id, undefined);
	}

	/** The watchdog: runs that haven't moved on for a while say so, and ones stuck far too long stop with a summary. */
	/** Each busy run's progress message says what it's waiting on right now, if anything (every few seconds). */
	async refreshWaits(): Promise<void> {
		if (this.#options.waitingFor === undefined) return;
		for (const [conversationId, view] of this.#views) {
			if (!view.busy) continue;
			view.waiting(await this.#options.waitingFor(conversationId).catch(() => undefined));
		}
	}

	async watch(now = Date.now()): Promise<void> {
		const { harness, context } = this.#options;
		for (const [conversationId, view] of this.#views) {
			if (!view.check(now)) continue;
			this.#options.audit?.record("stop", { actor: "scout", conversationId, detail: { why: "no progress" } });
			const conversation = await harness.conversation(conversationId as ConversationId, context);
			await conversation?.abort(context);
		}
	}

	async #stop(thread: ThreadRow, user: string): Promise<void> {
		const { harness, context } = this.#options;
		const view = await this.#view(thread);
		if (!view.busy) return;
		view.markStopped(await this.#options.nameOf(user));
		this.#options.audit?.record("stop", { actor: user, conversationId: thread.conversationId, channel: thread.channel });
		const conversation = await harness.conversation(thread.conversationId as ConversationId, context);
		await conversation?.abort(context);
	}

	#withoutMention(text: string): string {
		return text.replaceAll(`<@${this.#options.botUserId}>`, "").trim();
	}

	/** `repo`: the thread's, once it has one; a new thread's is the one its first message would start in. */
	async #admit(message: IncomingMessage, starting: boolean, threadRepo?: string): Promise<Admission> {
		if (this.#options.admit === undefined) return { ok: true };
		const repo = threadRepo ?? this.#options.repoFor?.(message.channelName, message.text);
		return this.#options.admit({ user: message.user, channelName: message.channelName, ...(repo === undefined ? {} : { repo }), starting });
	}

	/** Tell someone why their message didn't start work, once in a while, in their thread. */
	async #refuse(message: IncomingMessage, threadTs: string, reason: string, conversationId?: number): Promise<void> {
		const key = `${message.channel}:${threadTs}:${message.user}:${reason}`;
		const last = this.#refused.get(key);
		this.#options.audit?.record("refused", {
			actor: message.user,
			...(conversationId === undefined ? {} : { conversationId }),
			channel: message.channelName,
			detail: { reason, ts: message.ts },
		});
		if (last !== undefined && Date.now() - last < REFUSAL_QUIET_MS) return;
		this.#refused.set(key, Date.now());
		await this.#options.surface.post(message.channel, threadTs, plain(`<@${message.user}> ${reason}`));
	}

	async #deliver(key: string, message: IncomingMessage, mentions: boolean, queued: boolean): Promise<"done" | "waiting"> {
		const { harness, threads, context } = this.#options;
		const threadTs = message.threadTs ?? message.ts;
		let thread = threads.get(key);
		if (thread === undefined) {
			if (!mentions) return "done";
			const admission = await this.#admit(message, true);
			if (!admission.ok && admission.wait !== true) {
				await this.#refuse(message, threadTs, admission.reason);
				return "done";
			}
			thread = await this.#startThread(key, message);
		}
		const conversation = await harness.conversation(thread.conversationId as ConversationId, context);
		if (conversation === undefined) throw new Error(`conversation ${thread.conversationId} is missing`);
		const view = await this.#view(thread);

		// "approve" from someone who may ask for work in this repository lets a waiting change go ahead, and wakes Scout.
		const threadRepo = (await harness.snapshot(ThreadDoc, thread.conversationId as ConversationId, context))?.repo;
		let approving = false;
		if (this.#options.approve !== undefined && APPROVAL.test(this.#withoutMention(message.text))) {
			approving = (await this.#admit(message, false, threadRepo)).ok;
			if (approving) {
				this.#options.approve(thread.conversationId, message.user);
				this.#options.audit?.record("approved", { actor: message.user, conversationId: thread.conversationId, channel: message.channelName, detail: { ts: message.ts } });
			}
		}
		let how = delivery({
			mentionsScout: mentions || approving,
			followsScout: thread.lastSpeaker === "scout" && thread.lastAsker === message.user,
			busy: view.busy,
		});
		if (how !== "note") {
			const starting = !view.busy;
			const admission = await this.#admit(message, starting, threadRepo);
			if (!admission.ok) {
				if (admission.wait === true && starting) {
					if (!queued) {
						threads.enqueue(key, message);
						// The message this run will use once it starts says it's waiting, and where it is in line.
						const place = threads.queued().length;
						const eta = this.#options.queueEta?.(place);
						view.queued(`⏳ ${admission.reason}${place > 1 ? ` You're ${ordinal(place)} in line.` : ""}${eta === undefined ? "" : ` My guess: ${eta}.`}`);
						this.#phase(message.channel, message.ts, "queued");
						this.#options.audit?.record("refused", { actor: message.user, conversationId: thread.conversationId, channel: message.channelName, detail: { reason: admission.reason, ts: message.ts, queued: true } });
					}
					return "waiting";
				}
				await this.#refuse(message, threadTs, admission.reason, thread.conversationId);
				how = "note";
			}
		}
		const name = await this.#options.nameOf(message.user);
		const text = message.text.replaceAll(`<@${this.#options.botUserId}>`, "@Scout").trim();
		const attached = await this.#attachments(thread.conversationId, message);
		const said = [`${name}: ${text}`, ...attached.notes].join("\n");
		const content = attached.images.length === 0 ? said : [{ type: "text" as const, text: said }, ...attached.images];
		const data = { user: message.user, name, text, ts: message.ts, ...(attached.notes.length > 0 ? { files: attached.notes } : {}) };
		const requestId = `slack:${message.channel}:${message.ts}`;

		if (how === "note") {
			await conversation.submit(
				{
					type: "write",
					requestId,
					entry: { kind: "slack.message", data, model: [{ role: "user", content, timestamp: Date.now() }] },
				},
				context,
			);
		} else {
			await conversation.submit(
				{ type: "input", content, whenBusy: "steer", requestId, entry: { kind: "slack.message", data } },
				context,
			);
			threads.asked(key, message.user);
			if (how === "steer") this.view(thread.conversationId)?.tookIn(name);
			// 👀 on the request: anyone scanning the channel sees it was picked up.
			this.#requests.set(thread.conversationId, [...(this.#requests.get(thread.conversationId) ?? []), { channel: message.channel, ts: message.ts }]);
			this.#phase(message.channel, message.ts, "picked");
		}
		threads.spoke(key, message.user);
		this.#options.audit?.record("request", {
			actor: message.user,
			conversationId: thread.conversationId,
			channel: message.channelName,
			detail: { as: how, ts: message.ts, text: text.slice(0, 200), ...(attached.notes.length > 0 ? { files: attached.notes.length } : {}) },
		});
		this.#options.search?.add({
			key,
			conversationId: thread.conversationId,
			channelName: message.channelName,
			speaker: name,
			text,
		});
		return "done";
	}

	/** Images for the model to see, and notes about the other files: where they are, or why they aren't. */
	async #attachments(
		conversationId: number,
		message: IncomingMessage,
	): Promise<{ images: { type: "image"; data: string; mimeType: string }[]; notes: string[] }> {
		const images: { type: "image"; data: string; mimeType: string }[] = [];
		const notes: string[] = [];
		const { download, saveAttachment } = this.#options;
		for (const file of message.files ?? []) {
			const image = IMAGE_TYPES.has(file.mimetype);
			const limit = image ? IMAGE_LIMIT : FILE_LIMIT;
			if (download === undefined || (!image && saveAttachment === undefined)) {
				notes.push(`(attached ${file.name}, which I can't open here)`);
			} else if (file.size > limit) {
				notes.push(`(attached ${file.name}, ${Math.round(file.size / 1024 / 1024)} MB: too big to open)`);
			} else {
				try {
					const bytes = await download(file.url, limit);
					if (image) {
						images.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: file.mimetype });
						notes.push(`(attached image ${file.name})`);
					} else {
						notes.push(`(attached ${file.name}, saved at ${await saveAttachment!(conversationId, file.name, bytes)})`);
					}
				} catch (error) {
					console.error(`couldn't fetch ${file.name}:`, error);
					notes.push(`(attached ${file.name}, which I couldn't download)`);
				}
			}
		}
		return { images, notes };
	}

	/**
	 * A thread Scout started itself, such as a pull request review's summary: its conversation starts knowing `context`
	 * (what Scout did and said there), so whoever replies can ask about it and Scout answers with that in mind.
	 */
	async openThread(thread: { channel: string; channelName: string; threadTs: string; context: string; about?: string; base?: string }): Promise<void> {
		const { harness, threads, context } = this.#options;
		const key = threadKey(thread.channel, thread.threadTs);
		if (threads.get(key) !== undefined) return;
		const row = await this.#startThread(key, { channel: thread.channel, channelName: thread.channelName, ts: thread.threadTs, user: "scout", text: thread.about ?? thread.context }, thread.base);
		const conversation = await harness.conversation(row.conversationId as ConversationId, context);
		await conversation?.submit(
			{
				type: "write",
				requestId: `opened:${key}`,
				entry: { kind: "scout.context", data: {}, model: [{ role: "user", content: thread.context, timestamp: Date.now() }] },
			},
			context,
		);
		threads.spoke(key, "scout");
		// So a later "fix what you flagged" outside this thread can still find it.
		this.#options.search?.add({ key, conversationId: row.conversationId, channelName: thread.channelName, speaker: "Scout", text: thread.about ?? thread.context });
	}

	/** Something said elsewhere (a comment on the code host) that a thread should know, without asking it for work. */
	async note(conversationId: number, text: string, requestId: string): Promise<void> {
		const { harness, context } = this.#options;
		const conversation = await harness.conversation(conversationId as ConversationId, context);
		await conversation?.submit(
			{ type: "write", requestId, entry: { kind: "forge.comment", data: {}, model: [{ role: "user", content: text, timestamp: Date.now() }] } },
			context,
		);
	}

	/**
	 * A thread for a conversation that started without one (a nightly reflection, from its announcement), so replies
	 * there reach it and its runs answer there.
	 */
	async adopt(conversationId: number, thread: { channel: string; channelName: string; threadTs: string; about: string }): Promise<void> {
		const { threads } = this.#options;
		const key = threadKey(thread.channel, thread.threadTs);
		if (threads.get(key) !== undefined || threads.byConversation(conversationId) !== undefined) return;
		threads.insert({ key, conversationId, channel: thread.channel, threadTs: thread.threadTs, startedBy: "scout" });
		threads.spoke(key, "scout");
		this.#options.search?.add({ key, conversationId, channelName: thread.channelName, speaker: "Scout", text: thread.about });
		await this.#view(threads.get(key)!);
	}

	/**
	 * Work Scout starts itself, such as an alert's investigation: a thread it opened, with `context`, then `prompt` as a
	 * request. It answers to budgets and concurrency like any request; if they say no, the thread says why.
	 */
	async investigate(thread: { channel: string; channelName: string; threadTs: string; context: string; prompt: string; requestId: string; base?: string }): Promise<void> {
		// The request, not the instructions around it, says which of the channel's repositories it's about.
		await this.openThread({ ...thread, about: thread.prompt });
		const row = this.#options.threads.get(threadKey(thread.channel, thread.threadTs));
		if (row !== undefined) await this.work(row.conversationId, thread.prompt, thread.requestId, "look into this");
	}

	/**
	 * Work Scout asks of one of its threads itself (an alert to look into, a red build to fix): a request in that thread,
	 * steering it if it's busy. It answers to budgets and concurrency; if they say no, the thread says why.
	 */
	async work(conversationId: number, prompt: string, requestId: string, doing: string): Promise<void> {
		const { harness, threads, context } = this.#options;
		const row = threads.byConversation(conversationId);
		if (row === undefined) return;
		const channelName = (await harness.snapshot(ThreadDoc, conversationId as ConversationId, context))?.channelName ?? "";
		const view = await this.#view(row);
		const admission = (await this.#options.admit?.({ user: "scout", channelName, starting: !view.busy })) ?? { ok: true };
		if (!admission.ok) {
			await this.#options.surface.post(row.channel, row.threadTs, plain(`I'd ${doing}, but ${admission.reason}`));
			return;
		}
		const conversation = await harness.conversation(conversationId as ConversationId, context);
		await conversation?.submit({ type: "input", content: prompt, whenBusy: "steer", requestId }, context);
		this.#options.audit?.record("request", { actor: "scout", conversationId, channel: channelName, detail: { as: "self", text: prompt.slice(0, 200) } });
	}

	async #startThread(key: string, message: Pick<IncomingMessage, "channel" | "channelName" | "ts" | "user" | "text"> & { threadTs?: string }, base?: string): Promise<ThreadRow> {
		const { harness, threads, context } = this.#options;
		const model = this.#options.modelFor?.(message.channelName);
		const agent = model === undefined ? this.#options.agent : { ...this.#options.agent, model };
		const threadTs = message.threadTs ?? message.ts;
		const conversation = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent,
				init: async (tx, id) => {
					const doc = await tx.doc(ThreadDoc, id);
					doc.channel = message.channel;
					doc.channelName = message.channelName;
					doc.threadTs = threadTs;
					const repo = this.#options.repoFor?.(message.channelName, message.text);
					if (repo !== undefined) doc.repo = repo;
					if (base !== undefined) doc.base = base;
				},
			},
			context,
		);
		threads.insert({
			key,
			conversationId: conversation.id,
			channel: message.channel,
			threadTs,
			startedBy: message.user,
		});
		return threads.get(key)!;
	}

	async #view(thread: ThreadRow): Promise<ThreadView> {
		const existing = this.#views.get(thread.conversationId);
		if (existing !== undefined) return existing;
		const { harness, threads, surface, context } = this.#options;
		const view = new ThreadView({
			surface,
			channel: thread.channel,
			threadTs: thread.threadTs,
			...(thread.runTs === undefined ? {} : { resumeTs: thread.runTs }),
			onRunMessage: (ts) => {
				threads.runMessage(thread.key, ts);
				if (ts !== undefined) this.#options.runStarted?.(thread.conversationId);
			},
			onSlow: () => (this.#slowAt = Date.now()),
			onPhase: (phase) => {
				for (const request of this.#requests.get(thread.conversationId) ?? []) this.#phase(request.channel, request.ts, phase);
			},
			behind: () => Date.now() - this.#slowAt < BEHIND_MS,
			...(this.#options.fallbackNotice === undefined ? {} : { fallback: () => this.#options.fallbackNotice!(thread.conversationId) }),
			...(this.#options.costNote === undefined ? {} : { cost: (since: number) => this.#options.costNote?.(thread.conversationId, since) }),
			pacer: this.pacer,
			onRunEnd: (answer, ts, outcome, durationMs) => {
				this.#options.ran?.(durationMs);
				// How the requests this run took ended: ✅, ⚠️, ✋ when stopped, 🙋 when the answer waits on someone.
				const ending: Ending = outcome === "stopped" ? "stopped" : outcome === "problem" ? "problem" : answer !== undefined && asksSomething(answer) ? "waiting" : "done";
				for (const request of this.#requests.get(thread.conversationId) ?? []) this.#status.finish(request.channel, request.ts, ending);
				this.#requests.delete(thread.conversationId);
				this.#options.answered?.(thread.conversationId, ts, answer, outcome);
				if (ts !== undefined) threads.answered(thread.key, ts);
				threads.spoke(thread.key, "scout");
				threads.ranOnce(thread.conversationId);
				void this.drain().catch((error: unknown) => console.error("starting queued requests failed:", error));
				if (answer === undefined || this.#options.search === undefined) return;
				const search = this.#options.search;
				void harness.snapshot(ThreadDoc, thread.conversationId as ConversationId, context).then((doc) =>
					search.add({
						key: thread.key,
						conversationId: thread.conversationId,
						channelName: doc?.channelName ?? "",
						speaker: "Scout",
						text: answer,
					}),
				);
			},
		});
		this.#views.set(thread.conversationId, view);
		const stream = await watchEvents(harness, thread.conversationId as ConversationId, context);
		view.handle([stream.snapshot]);
		stream.start(async (events) => view.handle(events));
		return view;
	}

	/** Messages in one thread are handled one at a time, in arrival order. */
	async #serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
		const previous = this.#locks.get(key) ?? Promise.resolve();
		const next = previous.then(work);
		const settled = next.catch(() => {});
		this.#locks.set(key, settled);
		try {
			return await next;
		} finally {
			if (this.#locks.get(key) === settled) this.#locks.delete(key);
		}
	}
}

/** A reply that approves a change waiting in the thread: the word alone, so "I don't approve" never counts. */
const APPROVAL = /^(approve|approved|go ahead)[.!]*$/i;

function plain(text: string): ChatMessage {
	return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}
