import { App, LogLevel } from "@slack/bolt";
import type { IncomingMessage, SharedFile } from "./bridge.ts";
import type { ChatMessage, ChatSurface } from "./render.ts";

/** Message subtypes that are still people talking; every other subtype (edits, joins, bots) is ignored. */
const SPOKEN_SUBTYPES = new Set([undefined, "thread_broadcast", "file_share"]);

const CREATE_CHANNEL_ACTION = "scout_create_channel";
/** The "Ask Scout about this" message shortcut (slack-manifest.yaml), and the form it opens. */
const ASK_SHORTCUT = "scout_ask";
const ASK_FORM = "scout_ask_form";

export type SlackHandlers = {
	onMessage: (message: IncomingMessage) => Promise<void>;
	onReaction: (reaction: { channel: string; ts: string; name: string; user: string; eventTs: string }) => Promise<void>;
	/** Someone edited a message (its new text) or deleted one. */
	onEdit?: (edit: { channel: string; ts: string; threadTs?: string; user: string; text: string }) => Promise<void>;
	onDelete?: (deleted: { channel: string; ts: string }) => void;
	/** Someone used "Ask Scout about this" on a message: what they asked, and the message it's about. */
	onAsk?: (ask: { user: string; channel: string; channelName: string; ts: string; threadTs?: string; author?: string; text: string; request: string }) => Promise<void>;
	/** Someone opened Scout's App Home tab: the view to show them. */
	home?: (user: string) => Promise<{ type: "home"; blocks: unknown[] }>;
};

/**
 * Slack over Socket Mode: no public URL, no tunnel. Everything Slack-specific lives here; the bridge sees decoded
 * messages and a `ChatSurface`.
 */
export class Slack {
	readonly app: App;
	readonly surface: ChatSurface;
	botUserId = "";
	readonly #names = new Map<string, string>();
	readonly #channels = new Map<string, string>();
	readonly #botToken: string;

	constructor(tokens: { botToken: string; appToken: string }) {
		this.#botToken = tokens.botToken;
		this.app = new App({ token: tokens.botToken, appToken: tokens.appToken, socketMode: true, logLevel: LogLevel.WARN });
		const client = this.app.client;
		this.surface = {
			post: async (channel, threadTs, original) => {
				const message = await this.#withMentions(original);
				const posted = await client.chat.postMessage({
					channel,
					...(threadTs === undefined ? {} : { thread_ts: threadTs }),
					text: message.text,
					blocks: message.blocks as never,
					unfurl_links: false,
				});
				return posted.ts ?? "";
			},
			update: async (channel, ts, original) => {
				const message = await this.#withMentions(original);
				await client.chat.update({ channel, ts, text: message.text, blocks: message.blocks as never });
			},
			// Needs the files:write scope; without it this fails, and the answer follows in messages instead.
			attach: async (channel, threadTs, file) => {
				await client.filesUploadV2({ channel_id: channel, thread_ts: threadTs, filename: file.name, title: file.title, content: file.content });
			},
		};
	}

	/** `@jason` in what Scout writes (or its profile tells it to write) becomes a real mention of that person. */
	async #withMentions(message: ChatMessage): Promise<ChatMessage> {
		if (!/@\w/.test(message.text) && !JSON.stringify(message.blocks).includes("@")) return message;
		const handles = await this.#handles();
		const blocks = message.blocks.map((block) => {
			const b = block as { type?: string; text?: unknown };
			return b.type === "markdown" && typeof b.text === "string" ? { ...b, text: mentionNames(b.text, handles) } : block;
		});
		return { text: mentionNames(message.text, handles), blocks };
	}

	#handleCache: { at: number; handles: Map<string, string> } | undefined;

	/** Everyone's Slack handle and display name, lowercased, to their user ID; refreshed hourly. Ambiguous ones are left out. */
	async #handles(): Promise<Map<string, string>> {
		if (this.#handleCache !== undefined && Date.now() - this.#handleCache.at < 60 * 60 * 1000) return this.#handleCache.handles;
		const seen = new Map<string, string | null>();
		const add = (name: string | undefined, id: string) => {
			const key = name?.trim().toLowerCase().replace(/\s+/g, "");
			if (!key) return;
			seen.set(key, seen.has(key) && seen.get(key) !== id ? null : id);
		};
		try {
			let cursor: string | undefined;
			do {
				const page = await this.app.client.users.list({ limit: 200, ...(cursor ? { cursor } : {}) });
				for (const user of page.members ?? []) {
					if (!user.id || user.deleted || user.is_bot) continue;
					add(user.name, user.id);
					add(user.profile?.display_name, user.id);
				}
				cursor = page.response_metadata?.next_cursor || undefined;
			} while (cursor !== undefined);
		} catch (error) {
			console.error("listing Slack users for mentions failed:", error instanceof Error ? error.message : error);
			return this.#handleCache?.handles ?? new Map();
		}
		const handles = new Map([...seen].flatMap(([name, id]) => (id === null ? [] : [[name, id] as const])));
		this.#handleCache = { at: Date.now(), handles };
		return handles;
	}

	/**
	 * What people said while Scout wasn't listening (a restart, a dropped connection), oldest first: top-level messages
	 * in the public channels it's in, and replies in `threads`, after `since` (ms). Socket Mode doesn't replay them.
	 */
	async missed(since: number, threads: readonly { channel: string; threadTs: string }[]): Promise<IncomingMessage[]> {
		const oldest = (since / 1000).toFixed(6);
		const client = this.app.client;
		const found = new Map<string, IncomingMessage>();
		const take = async (channel: string, m: Record<string, unknown>) => {
			if (!SPOKEN_SUBTYPES.has(m.subtype as string | undefined) || m.bot_id !== undefined) return;
			if (typeof m.user !== "string" || typeof m.ts !== "string" || Number(m.ts) <= Number(oldest)) return;
			found.set(`${channel}:${m.ts}`, {
				channel,
				channelType: "channel",
				channelName: await this.channelName(channel),
				user: m.user,
				text: typeof m.text === "string" ? m.text : "",
				ts: m.ts,
				...(typeof m.thread_ts === "string" && m.thread_ts !== m.ts ? { threadTs: m.thread_ts } : {}),
				...(Array.isArray(m.files) ? { files: sharedFiles(m.files) } : {}),
			});
		};
		const mine = await client.users.conversations({ types: "public_channel", limit: 200, exclude_archived: true });
		for (const channel of mine.channels ?? []) {
			if (channel.id === undefined) continue;
			const history = await client.conversations.history({ channel: channel.id, oldest, limit: 200 });
			for (const m of history.messages ?? []) await take(channel.id, m as Record<string, unknown>);
		}
		for (const t of threads) {
			const replies = await client.conversations.replies({ channel: t.channel, ts: t.threadTs, oldest, limit: 200 }).catch(() => undefined);
			for (const m of replies?.messages ?? []) await take(t.channel, m as Record<string, unknown>);
		}
		return [...found.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
	}

	/** An edited or deleted message, from a person (not a bot, and not just Slack adding a link preview). */
	async #changed(e: Record<string, unknown>, handlers: SlackHandlers): Promise<void> {
		const channel = typeof e.channel === "string" ? e.channel : undefined;
		if (channel === undefined) return;
		if (e.subtype === "message_deleted") {
			if (typeof e.deleted_ts === "string") handlers.onDelete?.({ channel, ts: e.deleted_ts });
			return;
		}
		const now = e.message as Record<string, unknown> | undefined;
		const before = e.previous_message as Record<string, unknown> | undefined;
		if (now === undefined || now.bot_id !== undefined || typeof now.user !== "string" || typeof now.ts !== "string" || typeof now.text !== "string") return;
		if (before?.text === now.text) return;
		await handlers.onEdit?.({ channel, ts: now.ts, user: now.user, text: now.text, ...(typeof now.thread_ts === "string" ? { threadTs: now.thread_ts } : {}) });
	}

	/** Scout's own Slack user ID, which mentions of it carry. */
	async identify(): Promise<string> {
		const auth = await this.app.client.auth.test();
		this.botUserId = auth.user_id ?? "";
		return this.botUserId;
	}

	async start(handlers: SlackHandlers): Promise<void> {

		this.app.event("message", async ({ event }) => {
			const e = event as unknown as Record<string, unknown>;
			if (e.subtype === "message_changed" || e.subtype === "message_deleted") {
				await this.#changed(e, handlers).catch((error: unknown) => console.error(`edit in ${String(e.channel)} failed:`, error));
				return;
			}
			if (!SPOKEN_SUBTYPES.has(e.subtype as string | undefined) || e.bot_id !== undefined) return;
			if (typeof e.user !== "string" || typeof e.channel !== "string" || typeof e.ts !== "string") return;
			const channelType = e.channel_type as IncomingMessage["channelType"];
			try {
				await handlers.onMessage({
					channel: e.channel,
					channelType,
					channelName: channelType === "channel" ? await this.channelName(e.channel) : "",
					user: e.user,
					text: typeof e.text === "string" ? e.text : "",
					ts: e.ts,
					...(typeof e.thread_ts === "string" ? { threadTs: e.thread_ts } : {}),
					...(Array.isArray(e.files) ? { files: sharedFiles(e.files) } : {}),
				});
			} catch (error) {
				console.error(`message ${e.channel}/${e.ts} failed:`, error);
			}
		});

		// "Ask Scout about this", from any message's menu: a short form, then a thread on that message.
		this.app.shortcut(ASK_SHORTCUT, async ({ shortcut, ack, client }) => {
			await ack();
			const s = shortcut as unknown as { trigger_id: string; channel: { id: string }; message: { ts: string; thread_ts?: string; user?: string; text?: string } };
			const text = (s.message.text ?? "").slice(0, 2_000);
			await client.views.open({
				trigger_id: s.trigger_id,
				view: {
					type: "modal",
					callback_id: ASK_FORM,
					private_metadata: JSON.stringify({ channel: s.channel.id, ts: s.message.ts, threadTs: s.message.thread_ts, author: s.message.user, text }),
					title: { type: "plain_text", text: "Ask Scout" },
					submit: { type: "plain_text", text: "Ask" },
					close: { type: "plain_text", text: "Cancel" },
					blocks: [
						{ type: "section", text: { type: "mrkdwn", text: text === "" ? "_(a message with no text)_" : text.split("\n").map((l) => `> ${l}`).join("\n").slice(0, 2_900) } },
						{
							type: "input",
							block_id: "request",
							label: { type: "plain_text", text: "What would you like me to do?" },
							element: { type: "plain_text_input", action_id: "text", multiline: true, placeholder: { type: "plain_text", text: "Look into this, explain it, fix it…" } },
						},
					],
				},
			});
		});

		this.app.view(ASK_FORM, async ({ ack, view, body }) => {
			const meta = JSON.parse(view.private_metadata) as { channel: string; ts: string; threadTs?: string; author?: string; text: string };
			const request = view.state.values.request?.text?.value?.trim() ?? "";
			// Scout works only in public channels it's in; say so in the form rather than failing afterwards.
			const info = await this.app.client.conversations.info({ channel: meta.channel }).catch(() => undefined);
			const open = info?.channel?.is_channel === true && info.channel.is_private !== true && info.channel.is_member === true;
			if (!open) {
				await ack({ response_action: "errors", errors: { request: "I only work in public channels I'm in. Invite me here, or ask me in a channel I'm in." } });
				return;
			}
			await ack();
			try {
				await handlers.onAsk?.({ user: body.user.id, channel: meta.channel, channelName: info?.channel?.name ?? meta.channel, ts: meta.ts, ...(meta.threadTs === undefined ? {} : { threadTs: meta.threadTs }), ...(meta.author === undefined ? {} : { author: meta.author }), text: meta.text, request });
			} catch (error) {
				console.error(`asking about ${meta.channel}/${meta.ts} failed:`, error);
			}
		});

		// Needs the Home tab enabled and the app_home_opened event (slack-manifest.yaml).
		this.app.event("app_home_opened", async ({ event }) => {
			if (event.tab !== "home" || handlers.home === undefined) return;
			try {
				await this.app.client.views.publish({ user_id: event.user, view: (await handlers.home(event.user)) as never });
			} catch (error) {
				console.error(`App Home for ${event.user} failed:`, error);
			}
		});

		this.app.event("reaction_added", async ({ event }) => {
			if (event.item.type !== "message") return;
			try {
				await handlers.onReaction({ channel: event.item.channel, ts: event.item.ts, name: event.reaction, user: event.user, eventTs: event.event_ts });
			} catch (error) {
				console.error(`reaction ${event.item.channel}/${event.item.ts} failed:`, error);
			}
		});

		this.app.action(CREATE_CHANNEL_ACTION, async ({ ack, body, respond }) => {
			await ack();
			const user = body.user.id;
			try {
				const channel = await this.#createChannelFor(user);
				await respond({ replace_original: true, text: `Done: <#${channel}>. Mention me there and we'll get going.` });
			} catch (error) {
				console.error("channel creation failed:", error);
				await respond({ replace_original: false, text: "I couldn't create the channel. Could you make one and invite me?" });
			}
		});

		await this.app.start();
	}

	async stop(): Promise<void> {
		await this.app.stop();
	}

	/** What Scout says to a direct message: no, but here's a public channel for the two of us. */
	channelOffer(user: string): ChatMessage {
		const text =
			"I don't work in direct messages. I work in public channels, so anyone can see what we do, chip in, and " +
			"learn from it. Want a channel for the two of us?";
		return {
			text,
			blocks: [
				{ type: "section", text: { type: "mrkdwn", text } },
				{
					type: "actions",
					elements: [
						{
							type: "button",
							action_id: CREATE_CHANNEL_ACTION,
							text: { type: "plain_text", text: "Create our channel" },
							value: user,
							style: "primary",
						},
					],
				},
			],
		};
	}

	/** A file shared in Slack; private file URLs need the bot's token. */
	async download(url: string): Promise<Uint8Array> {
		const response = await fetch(url, { headers: { authorization: `Bearer ${this.#botToken}` } });
		if (!response.ok) throw new Error(`Slack answered ${response.status}`);
		return new Uint8Array(await response.arrayBuffer());
	}

	/** Members of a Slack user group (needs usergroups:read). */
	async groupMembers(group: string): Promise<Set<string>> {
		const members = await this.app.client.usergroups.users.list({ usergroup: group });
		return new Set(members.users ?? []);
	}

	async nameOf(user: string): Promise<string> {
		const cached = this.#names.get(user);
		if (cached !== undefined) return cached;
		const info = await this.app.client.users.info({ user });
		const profile = info.user?.profile;
		const name = profile?.display_name || profile?.real_name || info.user?.name || user;
		this.#names.set(user, name);
		return name;
	}

	/** A user's email, to find them in the identity provider; needs the `users:read.email` scope. */
	async emailOf(user: string): Promise<string | undefined> {
		const info = await this.app.client.users.info({ user }).catch(() => undefined);
		return info?.user?.profile?.email || undefined;
	}

	async channelName(channel: string): Promise<string> {
		const cached = this.#channels.get(channel);
		if (cached !== undefined) return cached;
		const info = await this.app.client.conversations.info({ channel });
		const name = info.channel?.name ?? channel;
		this.#channels.set(channel, name);
		return name;
	}

	/** A public channel's ID from its name (without `#`), or undefined when there's none by that name. */
	async channelId(name: string): Promise<string | undefined> {
		for (const [id, known] of this.#channels) if (known === name) return id;
		let cursor: string | undefined;
		do {
			const page = await this.app.client.conversations.list({ types: "public_channel", exclude_archived: true, limit: 200, ...(cursor ? { cursor } : {}) });
			for (const channel of page.channels ?? []) if (channel.id && channel.name) this.#channels.set(channel.id, channel.name);
			const found = page.channels?.find((c) => c.name === name)?.id;
			if (found !== undefined) return found;
			cursor = page.response_metadata?.next_cursor || undefined;
		} while (cursor !== undefined);
		return undefined;
	}

	/**
	 * A reply that also shows in the channel ("Also send to #channel"), so people scanning the channel can see what came
	 * of a thread they'd otherwise have to open.
	 */
	async broadcast(channel: string, threadTs: string, text: string): Promise<void> {
		await this.app.client.chat.postMessage({ channel, thread_ts: threadTs, reply_broadcast: true, text, unfurl_links: false });
	}

	async permalink(channel: string, ts: string): Promise<string | undefined> {
		const link = await this.app.client.chat.getPermalink({ channel, message_ts: ts }).catch(() => undefined);
		return link?.permalink;
	}

	async #createChannelFor(user: string): Promise<string> {
		const base = slackChannelName(`${await this.nameOf(user)}_scout`);
		for (let attempt = 0; attempt < 5; attempt++) {
			const name = attempt === 0 ? base : `${base}-${attempt + 1}`;
			const created = await this.app.client.conversations
				.create({ name, is_private: false })
				.catch((error: { data?: { error?: string } }) => {
					if (error.data?.error === "name_taken") return undefined;
					throw error;
				});
			const channel = created?.channel?.id;
			if (channel === undefined) continue;
			await this.app.client.conversations.invite({ channel, users: user });
			await this.surface.post(channel, undefined, {
				text: `Hi <@${user}>. This channel is ours, and it's public, so anyone can follow along.`,
				blocks: [],
			});
			return channel;
		}
		throw new Error(`no free channel name like ${base}`);
	}
}

function sharedFiles(files: unknown[]): SharedFile[] {
	return files.flatMap((f) => {
		const file = f as Record<string, unknown>;
		const url = file.url_private_download ?? file.url_private;
		if (typeof url !== "string") return [];
		return [
			{
				name: typeof file.name === "string" ? file.name : "file",
				mimetype: typeof file.mimetype === "string" ? file.mimetype : "application/octet-stream",
				size: typeof file.size === "number" ? file.size : 0,
				url,
			},
		];
	});
}

export function slackChannelName(text: string): string {
	return (
		text
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "")
			.replace(/[^a-z0-9_-]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 70) || "scout"
	);
}

/**
 * `@name` → `<@ID>` for names in `handles` (lowercased Slack handles and display names), outside code spans and fences,
 * so `@scope/package` and decorators stay as written. A trailing `.` or `-` (end of a sentence) isn't part of the name.
 */
export function mentionNames(text: string, handles: ReadonlyMap<string, string>): string {
	return text
		.split(/(```[\s\S]*?```|`[^`\n]*`)/)
		.map((part, i) =>
			i % 2 === 1
				? part
				: part.replace(/(^|[^\w<`/])@([A-Za-z0-9][\w.-]*)(?![\w/])/g, (whole, before: string, name: string) => {
						const bare = name.replace(/[.-]+$/, "");
						const id = handles.get(bare.toLowerCase());
						return id === undefined ? whole : `${before}<@${id}>${name.slice(bare.length)}`;
					}),
		)
		.join("");
}
