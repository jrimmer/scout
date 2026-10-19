import type { Context } from "@earendil-works/chord";
import { type AgentChange, type ConversationId, type Harness, watchEvents } from "@earendil-works/pi-durable";
import { delivery } from "./etiquette.ts";
import { ThreadDoc } from "./profile.ts";
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
};

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
};

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
	readonly #locks = new Map<string, Promise<void>>();

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
		await this.#serialized(key, () => this.#deliver(key, message, mentions));
	}

	async #deliver(key: string, message: IncomingMessage, mentions: boolean): Promise<void> {
		const { harness, threads, context } = this.#options;
		let thread = threads.get(key);
		if (thread === undefined) {
			if (!mentions) return;
			thread = await this.#startThread(key, message);
		}
		const conversation = await harness.conversation(thread.conversationId as ConversationId, context);
		if (conversation === undefined) throw new Error(`conversation ${thread.conversationId} is missing`);
		const view = await this.#view(thread);

		const how = delivery({
			mentionsScout: mentions,
			followsScout: thread.lastSpeaker === "scout" && thread.lastAsker === message.user,
			busy: view.busy,
		});
		const name = await this.#options.nameOf(message.user);
		const text = message.text.replaceAll(`<@${this.#options.botUserId}>`, "@Scout").trim();
		const content = `${name}: ${text}`;
		const data = { user: message.user, name, text, ts: message.ts };
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
		}
		threads.spoke(key, message.user);
	}

	async #startThread(key: string, message: IncomingMessage): Promise<ThreadRow> {
		const { harness, threads, agent, context } = this.#options;
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
			onRunEnd: () => {
				threads.spoke(thread.key, "scout");
				threads.ranOnce(thread.conversationId);
			},
		});
		this.#views.set(thread.conversationId, view);
		const stream = await watchEvents(harness, thread.conversationId as ConversationId, context);
		view.handle([stream.snapshot]);
		stream.start(async (events) => view.handle(events));
		return view;
	}

	/** Messages in one thread are handled one at a time, in arrival order. */
	async #serialized(key: string, work: () => Promise<void>): Promise<void> {
		const previous = this.#locks.get(key) ?? Promise.resolve();
		const next = previous.then(work);
		const settled = next.catch(() => {});
		this.#locks.set(key, settled);
		try {
			await next;
		} finally {
			if (this.#locks.get(key) === settled) this.#locks.delete(key);
		}
	}
}

function plain(text: string): ChatMessage {
	return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
}
