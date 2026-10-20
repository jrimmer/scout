import type { Context } from "@earendil-works/chord";
import { type AgentChange, type ConversationId, type Harness, watchEvents } from "@earendil-works/pi-durable";
import type { Audit } from "./audit.ts";
import { delivery } from "./etiquette.ts";
import type { Admission } from "./limits.ts";
import { ThreadDoc } from "./docs.ts";
import type { ThreadSearch } from "./search.ts";
import { type ChatMessage, type ChatSurface, ThreadView } from "./render.ts";
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
	/** The repository a thread starts in, from its channel and its first message. */
	repoFor?: (channelName: string, text?: string) => string;
	/** A channel's own model, if its profile names one; otherwise `agent`'s. */
	modelFor?: (channelName: string) => { provider: string; modelId: string } | undefined;
	/** Download a shared file (Slack needs the bot's token for that). */
	download?: (url: string) => Promise<Uint8Array>;
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
	readonly #locks = new Map<string, Promise<unknown>>();
	readonly #refused = new Map<string, number>();
	#draining = false;

	constructor(options: BridgeOptions) {
		this.#options = options;
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
			}
		} finally {
			this.#draining = false;
		}
	}

	/** A reaction on a message: a stop sign on a thread's first message or on Scout's progress message stops it. */
	async onReaction(reaction: { channel: string; ts: string; name: string; user: string }): Promise<void> {
		if (!STOP_REACTIONS.has(reaction.name)) return;
		let thread = this.#options.threads.get(threadKey(reaction.channel, reaction.ts));
		if (thread === undefined) {
			for (const [conversationId, view] of this.#views) {
				if (view.runTs === reaction.ts) thread = this.#options.threads.byConversation(conversationId);
			}
		}
		if (thread !== undefined && thread.channel === reaction.channel) await this.#stop(thread, reaction.user);
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

		let how = delivery({
			mentionsScout: mentions,
			followsScout: thread.lastSpeaker === "scout" && thread.lastAsker === message.user,
			busy: view.busy,
		});
		if (how !== "note") {
			const starting = !view.busy;
			const threadRepo = (await harness.snapshot(ThreadDoc, thread.conversationId as ConversationId, context))?.repo;
			const admission = await this.#admit(message, starting, threadRepo);
			if (!admission.ok) {
				if (admission.wait === true && starting) {
					if (!queued) {
						threads.enqueue(key, message);
						await this.#refuse(message, threadTs, admission.reason, thread.conversationId);
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
					const bytes = await download(file.url);
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
	async openThread(thread: { channel: string; channelName: string; threadTs: string; context: string; about?: string }): Promise<void> {
		const { harness, threads, context } = this.#options;
		const key = threadKey(thread.channel, thread.threadTs);
		if (threads.get(key) !== undefined) return;
		const row = await this.#startThread(key, { channel: thread.channel, channelName: thread.channelName, ts: thread.threadTs, user: "scout", text: thread.about ?? thread.context });
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
	}

	/**
	 * Work Scout starts itself, such as an alert's investigation: a thread it opened, with `context`, then `prompt` as a
	 * request. It answers to budgets and concurrency like any request; if they say no, the thread says why.
	 */
	async investigate(thread: { channel: string; channelName: string; threadTs: string; context: string; prompt: string; requestId: string }): Promise<void> {
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

	async #startThread(key: string, message: Pick<IncomingMessage, "channel" | "channelName" | "ts" | "user" | "text"> & { threadTs?: string }): Promise<ThreadRow> {
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
			onRunMessage: (ts) => threads.runMessage(thread.key, ts),
			onRunEnd: (answer) => {
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

function plain(text: string): ChatMessage {
	return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}
